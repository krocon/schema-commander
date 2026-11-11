//! SSH tunnels to databases behind a jump host (prompt 014): `russh`, a `direct-tcpip` channel per
//! database connection, behind a listener on `127.0.0.1` with a port the OS picks. Host keys are checked
//! against `known_hosts` ([`trust`]); an unknown key must be confirmed by its fingerprint, a changed one is
//! refused. Client and authentication after log-commander (`remote/mod.rs`, its security review 017).
//! Pure of Tauri.

pub mod ssh_config;
#[cfg(test)]
pub mod testserver;
pub mod trust;

use crate::db::secrets::Secret;
use crate::error::{AppError, AppResult, ErrorCode};
use parking_lot::Mutex;
use russh::keys::PublicKey;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use trust::{HostKeyCheck, KnownHosts, fingerprint};

/// Connecting and logging in at most.
pub const SSH_TIMEOUT: Duration = Duration::from_secs(20);
/// Keys of the agent that are offered at most (a server counts every offer as a failed login).
pub const MAX_AGENT_TRIES: usize = 6;

/// A file only the user can read (0600 on Unix); `append` keeps what is there.
pub fn create_private_file(path: &Path, append: bool) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// How to log in at the SSH server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    /// The keys of the running SSH agent.
    #[default]
    Agent,
    /// A key file (its passphrase is asked for or taken from the keychain).
    Key,
    Password,
}

/// The jump host of a profile – never a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    /// 0 = 22.
    #[serde(default)]
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    /// The key file for [`SshAuth::Key`]; empty = the usual ones in `~/.ssh`.
    #[serde(default)]
    pub key_file: String,
}

impl SshTarget {
    pub fn port_or_default(&self) -> u16 {
        if self.port == 0 { 22 } else { self.port }
    }

    /// `user@host:port`, for messages and as the subject of the stored password.
    pub fn label(&self) -> String {
        format!(
            "{}@{}:{}",
            self.user.trim(),
            self.host.trim(),
            self.port_or_default()
        )
    }

    /// The key files to try, in order.
    pub fn key_files(&self) -> Vec<PathBuf> {
        let given = self.key_file.trim();
        if !given.is_empty() {
            let path = match given.strip_prefix("~/") {
                Some(rest) => ssh_config::home_dir().map(|h| h.join(rest)),
                None => Some(PathBuf::from(given)),
            };
            return path.into_iter().collect();
        }
        let Some(home) = ssh_config::home_dir() else {
            return Vec::new();
        };
        ["id_ed25519", "id_ecdsa", "id_rsa"]
            .iter()
            .map(|name| home.join(".ssh").join(name))
            .collect()
    }
}

/// What the user gave for this connect.
#[derive(Debug, Clone, Default)]
pub struct SshCredentials {
    /// The password, or the passphrase of the key file.
    pub secret: Option<Secret>,
    /// The fingerprint the user confirmed for an unknown host key.
    pub trust_fingerprint: Option<String>,
}

fn ssh_error(e: &russh::Error, label: &str) -> AppError {
    AppError::new(ErrorCode::ConnectionFailed, format!("SSH {label}: {e}"))
}

fn secret_required(what: &str) -> AppError {
    AppError::new(ErrorCode::SshSecretRequired, what.to_string())
}

/// What the host key check saw, for the error after a refused connect.
#[derive(Debug, Clone)]
enum Seen {
    Unknown {
        key_type: String,
        fingerprint: String,
    },
    Changed {
        key_type: String,
        fingerprint: String,
        file: PathBuf,
        line: usize,
        reason: &'static str,
    },
    LearnFailed(String),
}

struct Client {
    host: String,
    port: u16,
    known: KnownHosts,
    trust: Option<String>,
    seen: Arc<Mutex<Option<Seen>>>,
}

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key: PublicKey = match server_public_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            // Host certificates count as their key (no @cert-authority).
            russh::keys::PublicKeyOrCertificate::Certificate(c) => {
                PublicKey::from(c.public_key().clone())
            }
        };
        let print = fingerprint(&key);
        let key_type = key.algorithm().to_string();
        let seen = match self.known.check(&self.host, self.port, &key) {
            HostKeyCheck::Known => return Ok(true),
            HostKeyCheck::Unknown if self.trust.as_deref() == Some(print.as_str()) => {
                // confirmed for exactly this key: recorded in the app's file
                match self.known.learn(&self.host, self.port, &key) {
                    Ok(()) => return Ok(true),
                    Err(e) => Seen::LearnFailed(e.to_string()),
                }
            }
            HostKeyCheck::Unknown => Seen::Unknown {
                key_type,
                fingerprint: print,
            },
            HostKeyCheck::Changed { file, line, reason } => Seen::Changed {
                key_type,
                fingerprint: print,
                file,
                line,
                reason: reason.as_str(),
            },
            HostKeyCheck::Revoked { file, line } => Seen::Changed {
                key_type,
                fingerprint: print,
                file,
                line,
                reason: "revoked",
            },
        };
        *self.seen.lock() = Some(seen);
        Ok(false)
    }

    // The server may not open channels towards us (agent, X11, forwarded ports, sessions): dropping the
    // reply rejects; russh's defaults would accept (log-commander security review 017 L1).
    async fn server_channel_open_agent_forward(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn server_channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _socket_path: &str,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn server_channel_open_direct_streamlocal(
        &mut self,
        _channel: russh::Channel<russh::client::Msg>,
        _socket_path: &str,
        _reply: russh::client::ChannelOpenHandle,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

fn host_key_error(seen: Seen, target: &SshTarget) -> AppError {
    let place = if target.port_or_default() == 22 {
        target.host.trim().to_string()
    } else {
        format!("[{}]:{}", target.host.trim(), target.port_or_default())
    };
    match seen {
        // the frontend reads type and fingerprint from behind the last colon
        Seen::Unknown {
            key_type,
            fingerprint,
        } => AppError::new(
            ErrorCode::HostKeyUnknown,
            format!("unknown host key of {place}: {key_type} {fingerprint}"),
        ),
        Seen::Changed {
            key_type,
            fingerprint,
            file,
            line,
            reason,
        } => {
            let at = if line > 0 {
                format!("{}:{line}", file.display())
            } else {
                file.display().to_string()
            };
            let why = match reason {
                "revoked" => format!("the host key of {place} is marked @revoked in {at}"),
                "unusable" => format!("{at} has an entry for {place} whose key cannot be read"),
                "cert_authority" => format!(
                    "{at} has an @cert-authority entry for {place}; host certificates are not supported"
                ),
                "unknown_marker" => format!("{at} has an entry with an unknown marker for {place}"),
                "unreadable" => {
                    format!("{at} cannot be read, so the host key of {place} cannot be checked")
                }
                _ => format!("the host key of {place} differs from the one in {at}"),
            };
            AppError::new(
                ErrorCode::HostKeyChanged,
                format!("{why} (server shows {key_type} {fingerprint})"),
            )
        }
        Seen::LearnFailed(e) => AppError::new(ErrorCode::Io, format!("host key not recorded: {e}")),
    }
}

/// The public halves of key files (`<file>.pub`), to offer the agent's matching keys first.
fn public_keys_of(files: &[PathBuf]) -> Vec<PublicKey> {
    files
        .iter()
        .filter_map(|f| {
            let mut name = f.as_os_str().to_owned();
            name.push(".pub");
            let text = std::fs::read_to_string(PathBuf::from(name)).ok()?;
            PublicKey::from_openssh(text.trim()).ok()
        })
        .collect()
}

/// The agent's keys in the order to offer: those of the key files first, then the rest; at most `cap`.
pub fn order_identities(
    keys: Vec<PublicKey>,
    preferred: &[PublicKey],
    cap: usize,
) -> Vec<PublicKey> {
    let rank = |k: &PublicKey| {
        preferred
            .iter()
            .position(|p| p.key_data() == k.key_data())
            .unwrap_or(usize::MAX)
    };
    let mut keys: Vec<(usize, usize, PublicKey)> = keys
        .into_iter()
        .enumerate()
        .map(|(i, k)| (rank(&k), i, k))
        .collect();
    keys.sort_by_key(|(rank, i, _)| (*rank, *i));
    keys.into_iter().take(cap).map(|(_, _, k)| k).collect()
}

async fn agent_auth(
    handle: &mut russh::client::Handle<Client>,
    user: &str,
    label: &str,
    preferred: &[PublicKey],
) -> AppResult<bool> {
    let failed = |e: russh::keys::Error| {
        AppError::new(ErrorCode::AuthFailed, format!("SSH {label}: agent: {e}"))
    };
    #[cfg(unix)]
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(failed)?
        .dynamic();
    #[cfg(windows)]
    let mut agent = match russh::keys::agent::client::AgentClient::connect_named_pipe(
        r"\\.\pipe\openssh-ssh-agent",
    )
    .await
    {
        Ok(a) => a.dynamic(),
        Err(_) => russh::keys::agent::client::AgentClient::connect_pageant()
            .await
            .map_err(failed)?
            .dynamic(),
    };
    let ids = agent.request_identities().await.map_err(failed)?;
    let rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let keys: Vec<PublicKey> = ids
        .into_iter()
        .filter_map(|id| match id {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => Some(key),
            _ => None,
        })
        .collect();
    for key in order_identities(keys, preferred, MAX_AGENT_TRIES) {
        let hash = if key.algorithm().is_rsa() {
            rsa_hash
        } else {
            None
        };
        if let Ok(r) = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
            && r.success()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// An open tunnel: a listener on `127.0.0.1` whose connections go through the SSH server to the database.
/// Dropped, it closes the listener and the SSH connection.
pub struct Tunnel {
    port: u16,
    /// Connections the listener may still take: one per [`Tunnel::permit`]. Anything else that finds
    /// the port is hung up on.
    permits: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
    handle: Arc<russh::client::Handle<Client>>,
}

impl Tunnel {
    /// The local port a driver connects to (on `127.0.0.1`).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Lets the next connection to the local port through. Called right before a driver connects.
    pub fn permit(&self) {
        self.permits.fetch_add(1, Ordering::SeqCst);
    }

    /// Whether the SSH connection still stands.
    pub fn is_open(&self) -> bool {
        !self.handle.is_closed() && !self.task.is_finished()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Opens the SSH connection, checks the host key, logs in and starts the listener for
/// `db_host:db_port` as seen from the SSH server.
///
/// Errors by stage: `connection_failed` (not reachable), `host_key_unknown`, `host_key_changed`,
/// `ssh_secret_required` (password or passphrase missing or wrong), `auth_failed`.
pub fn open(
    target: &SshTarget,
    db_host: &str,
    db_port: u16,
    known: &KnownHosts,
    creds: &SshCredentials,
) -> AppResult<Tunnel> {
    let label = target.label();
    let host = target.host.trim().to_string();
    let port = target.port_or_default();
    let user = target.user.trim().to_string();
    if host.is_empty() || user.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidProfile,
            "SSH: host and user are needed",
        ));
    }
    let files = target.key_files();
    // key files are read before connecting: a wrong passphrase needs no round trip
    let key = match target.auth {
        SshAuth::Key => {
            let Some(file) = files.iter().find(|f| f.is_file()) else {
                return Err(AppError::new(
                    ErrorCode::NotFound,
                    "SSH: no key file (none given, none in ~/.ssh)",
                ));
            };
            let subject = file.display().to_string();
            match russh::keys::load_secret_key(file, None) {
                Ok(k) => Some(Arc::new(k)),
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    let Some(secret) = creds.secret.as_ref() else {
                        return Err(secret_required(&format!(
                            "the key file {subject} is encrypted: passphrase needed"
                        )));
                    };
                    match russh::keys::load_secret_key(file, Some(secret.expose())) {
                        Ok(k) => Some(Arc::new(k)),
                        Err(_) => {
                            return Err(secret_required(&format!(
                                "wrong passphrase for the key file {subject}"
                            )));
                        }
                    }
                }
                Err(e) => {
                    return Err(AppError::new(
                        ErrorCode::AuthFailed,
                        format!("SSH: {subject} is not a usable key ({e})"),
                    ));
                }
            }
        }
        _ => None,
    };
    // Without a password the host key is checked first (connect, compare, hang up): nobody is asked for
    // a password for a server whose key is unknown or changed.
    let password = if target.auth == SshAuth::Password {
        creds.secret.clone()
    } else {
        None
    };
    let probe = target.auth == SshAuth::Password && password.is_none();
    let preferred = if target.auth == SshAuth::Agent {
        public_keys_of(&files)
    } else {
        Vec::new()
    };
    let seen = Arc::new(Mutex::new(None));
    let client = Client {
        host: host.clone(),
        port,
        known: known.clone(),
        trust: creds.trust_fingerprint.clone(),
        seen: Arc::clone(&seen),
    };
    let config = russh::client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        preferred: russh::Preferred {
            key: std::borrow::Cow::Owned(known.preferred_algorithms(&host, port)),
            ..Default::default()
        },
        ..Default::default()
    };
    let auth = target.auth;
    let lbl = label.clone();
    let connect_host = host.clone();
    let result = crate::db::block(Some(SSH_TIMEOUT), &|| false, async move {
        let mut handle =
            match russh::client::connect(Arc::new(config), (connect_host.as_str(), port), client)
                .await
            {
                Ok(h) => h,
                Err(e) => return Ok(Err(e)),
            };
        if probe {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            return Err(secret_required(&format!("password needed for {lbl}")));
        }
        let ok = match auth {
            SshAuth::Password => {
                let Some(pw) = password else {
                    return Err(secret_required(&format!("password needed for {lbl}")));
                };
                handle
                    .authenticate_password(user.clone(), pw.expose())
                    .await
                    .map(|r| r.success())
                    .map_err(|e| ssh_error(&e, &lbl))?
            }
            SshAuth::Key => {
                let Some(key) = key else {
                    return Err(AppError::new(ErrorCode::AuthFailed, "SSH: no key"));
                };
                let hash = if key.algorithm().is_rsa() {
                    handle
                        .best_supported_rsa_hash()
                        .await
                        .ok()
                        .flatten()
                        .flatten()
                } else {
                    None
                };
                handle
                    .authenticate_publickey(
                        user.clone(),
                        russh::keys::PrivateKeyWithHashAlg::new(key, hash),
                    )
                    .await
                    .map(|r| r.success())
                    .map_err(|e| ssh_error(&e, &lbl))?
            }
            SshAuth::Agent => agent_auth(&mut handle, &user, &lbl, &preferred).await?,
        };
        Ok(Ok((handle, ok)))
    });
    let seen = seen.lock().take();
    let (handle, ok) = match result {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            return Err(match seen {
                Some(s) => host_key_error(s, target),
                None => ssh_error(&e, &label),
            });
        }
        Err(e) => {
            return Err(match seen {
                Some(s) => host_key_error(s, target),
                None => e,
            });
        }
    };
    if !ok {
        return Err(match target.auth {
            SshAuth::Password => secret_required(&format!("password not accepted for {label}")),
            SshAuth::Agent => AppError::new(
                ErrorCode::AuthFailed,
                format!("SSH {label}: the agent has no key the server accepts"),
            ),
            SshAuth::Key => AppError::new(
                ErrorCode::AuthFailed,
                format!("SSH {label}: the server does not accept this key"),
            ),
        });
    }
    let handle = Arc::new(handle);
    let permits = Arc::new(AtomicUsize::new(0));
    // Only this machine can reach the listener, and it takes only connections we announced.
    let listener = crate::db::runtime()
        .block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| AppError::new(ErrorCode::Io, format!("SSH tunnel: no local port ({e})")))?;
    let local = listener
        .local_addr()
        .map_err(|e| AppError::new(ErrorCode::Io, format!("SSH tunnel: {e}")))?
        .port();
    let task = crate::db::runtime().spawn(forward(
        listener,
        Arc::clone(&handle),
        Arc::clone(&permits),
        db_host.trim().to_string(),
        db_port,
    ));
    Ok(Tunnel {
        port: local,
        permits,
        task,
        handle,
    })
}

/// Takes the announced connections and joins each with a `direct-tcpip` channel to the database.
async fn forward(
    listener: tokio::net::TcpListener,
    handle: Arc<russh::client::Handle<Client>>,
    permits: Arc<AtomicUsize>,
    db_host: String,
    db_port: u16,
) {
    loop {
        let Ok((mut socket, peer)) = listener.accept().await else {
            return;
        };
        // a connection nobody announced: another program found the port
        #[allow(deprecated)] // `try_update` is newer than the oldest Rust we build with
        let allowed = permits
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok();
        if !allowed || !peer.ip().is_loopback() {
            continue;
        }
        let handle = Arc::clone(&handle);
        let db_host = db_host.clone();
        tokio::spawn(async move {
            let channel = handle
                .channel_open_direct_tcpip(db_host, u32::from(db_port), "127.0.0.1", 0)
                .await;
            // the tunnel's target refused: the driver sees its connection end
            if let Ok(channel) = channel {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use tempfile::tempdir;

    /// A TCP server that answers every line with `echo: <line>` – the "database" behind the tunnel.
    fn echo_server() -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut buf = [0u8; 256];
                    while let Ok(n) = stream.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        let mut out = b"echo: ".to_vec();
                        out.extend_from_slice(&buf[..n]);
                        if stream.write_all(&out).is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    fn known(dir: &Path) -> KnownHosts {
        KnownHosts {
            user: None,
            app: dir.join("known_hosts"),
        }
    }

    fn target(port: u16, auth: SshAuth) -> SshTarget {
        SshTarget {
            host: "127.0.0.1".into(),
            port,
            user: testserver::USER.into(),
            auth,
            key_file: String::new(),
        }
    }

    fn with_password() -> SshCredentials {
        SshCredentials {
            secret: Some(Secret::new(testserver::PASSWORD)),
            trust_fingerprint: None,
        }
    }

    fn ask(port: u16, text: &str) -> std::io::Result<String> {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.write_all(text.as_bytes())?;
        let mut buf = [0u8; 256];
        let n = stream.read(&mut buf)?;
        Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
    }

    /// The fingerprint an unknown server shows, read from the error as the frontend does.
    fn shown_fingerprint(e: &AppError) -> String {
        assert_eq!(e.code, ErrorCode::HostKeyUnknown, "{e}");
        e.message.rsplit(' ').next().unwrap().to_string()
    }

    fn trusted(server: &testserver::TestSsh, dir: &Path, auth: SshAuth) -> SshCredentials {
        let e = open(
            &target(server.port, auth),
            "127.0.0.1",
            1,
            &known(dir),
            &with_password(),
        )
        .err()
        .unwrap();
        SshCredentials {
            trust_fingerprint: Some(shown_fingerprint(&e)),
            ..with_password()
        }
    }

    #[test]
    fn an_unknown_host_key_must_be_confirmed_by_its_fingerprint() {
        let dir = tempdir().unwrap();
        let server = testserver::start(1, None).unwrap();
        let t = target(server.port, SshAuth::Password);
        let e = open(&t, "127.0.0.1", 1, &known(dir.path()), &with_password())
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::HostKeyUnknown);
        assert!(e.message.contains("ssh-ed25519 SHA256:"), "{e}");
        // nobody logged in at a server whose key is not trusted
        assert_eq!(server.counters.logins.load(Ordering::SeqCst), 0);
        // another fingerprint than the one shown does not help
        let wrong = SshCredentials {
            trust_fingerprint: Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()),
            ..with_password()
        };
        let e2 = open(&t, "127.0.0.1", 1, &known(dir.path()), &wrong)
            .err()
            .unwrap();
        assert_eq!(e2.code, ErrorCode::HostKeyUnknown);
        assert!(!dir.path().join("known_hosts").exists());
        // the right one is recorded, and from then on the server is known
        let creds = SshCredentials {
            trust_fingerprint: Some(shown_fingerprint(&e)),
            ..with_password()
        };
        let echo = echo_server();
        let tunnel = open(&t, "127.0.0.1", echo, &known(dir.path()), &creds).unwrap();
        drop(tunnel);
        open(&t, "127.0.0.1", echo, &known(dir.path()), &with_password()).unwrap();
    }

    #[test]
    fn a_changed_host_key_is_refused_whatever_is_confirmed() {
        let dir = tempdir().unwrap();
        let first = testserver::start(1, None).unwrap();
        let creds = trusted(&first, dir.path(), SshAuth::Password);
        let port = first.port;
        open(
            &target(port, SshAuth::Password),
            "127.0.0.1",
            1,
            &known(dir.path()),
            &creds,
        )
        .unwrap();
        // the record is for `[127.0.0.1]:port`: another server behind the same name and port
        let text = std::fs::read_to_string(dir.path().join("known_hosts")).unwrap();
        drop(first);
        let other = testserver::start(2, None).unwrap();
        std::fs::write(
            dir.path().join("known_hosts"),
            text.replace(&format!(":{port}"), &format!(":{}", other.port)),
        )
        .unwrap();
        let t = target(other.port, SshAuth::Password);
        let e = open(&t, "127.0.0.1", 1, &known(dir.path()), &with_password())
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::HostKeyChanged, "{e}");
        // confirming the new fingerprint is no way past
        let shown = e
            .message
            .rsplit(' ')
            .next()
            .unwrap()
            .trim_end_matches(')')
            .to_string();
        let insist = SshCredentials {
            trust_fingerprint: Some(shown),
            ..with_password()
        };
        let e = open(&t, "127.0.0.1", 1, &known(dir.path()), &insist)
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::HostKeyChanged);
        assert_eq!(other.counters.logins.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn asks_for_the_password_only_after_the_host_key_and_says_when_it_is_wrong() {
        let dir = tempdir().unwrap();
        let server = testserver::start(3, None).unwrap();
        let t = target(server.port, SshAuth::Password);
        // unknown key and no password: the key comes first
        let e = open(
            &t,
            "127.0.0.1",
            1,
            &known(dir.path()),
            &SshCredentials::default(),
        )
        .err()
        .unwrap();
        assert_eq!(e.code, ErrorCode::HostKeyUnknown);
        let trust = Some(shown_fingerprint(&e));
        let none = SshCredentials {
            secret: None,
            trust_fingerprint: trust.clone(),
        };
        let e = open(&t, "127.0.0.1", 1, &known(dir.path()), &none)
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::SshSecretRequired);
        assert!(e.message.contains("password needed"));
        let wrong = SshCredentials {
            secret: Some(Secret::new("nope")),
            trust_fingerprint: trust,
        };
        let e = open(&t, "127.0.0.1", 1, &known(dir.path()), &wrong)
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::SshSecretRequired);
        assert!(e.message.contains("not accepted"));
        // no secret in any message
        assert!(!e.message.contains("nope"));
    }

    #[test]
    fn carries_announced_connections_to_the_target_and_no_others() {
        let dir = tempdir().unwrap();
        let server = testserver::start(4, None).unwrap();
        let creds = trusted(&server, dir.path(), SshAuth::Password);
        let echo = echo_server();
        let t = target(server.port, SshAuth::Password);
        let tunnel = open(&t, "127.0.0.1", echo, &known(dir.path()), &creds).unwrap();
        assert!(tunnel.is_open());
        // a program that merely finds the port gets nothing
        let stray = ask(tunnel.port(), "hello\n");
        assert!(matches!(stray.as_deref(), Err(_) | Ok("")), "{stray:?}");
        assert_eq!(server.counters.tunnels.load(Ordering::SeqCst), 0);
        // an announced connection goes through – once per permit
        tunnel.permit();
        assert_eq!(ask(tunnel.port(), "hello\n").unwrap(), "echo: hello\n");
        let again = ask(tunnel.port(), "again\n");
        assert!(matches!(again.as_deref(), Err(_) | Ok("")), "{again:?}");
        tunnel.permit();
        tunnel.permit();
        assert_eq!(ask(tunnel.port(), "a\n").unwrap(), "echo: a\n");
        assert_eq!(ask(tunnel.port(), "b\n").unwrap(), "echo: b\n");
        assert_eq!(server.counters.tunnels.load(Ordering::SeqCst), 3);
        // the listener is bound to this machine only
        let port = tunnel.port();
        drop(tunnel);
        std::thread::sleep(Duration::from_millis(100));
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn logs_in_with_a_key_file_with_and_without_a_passphrase() {
        use russh::keys::ssh_key::LineEnding;
        let dir = tempdir().unwrap();
        let key = testserver::host_key(77);
        let plain = dir.path().join("id_plain");
        std::fs::write(&plain, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        // the same key with a passphrase, as ssh-keygen writes it
        let locked = dir.path().join("id_locked");
        std::fs::copy(&plain, &locked).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let keygen = std::process::Command::new("ssh-keygen")
            .args(["-p", "-q", "-N", "open sesame", "-P", "", "-f"])
            .arg(&locked)
            .status();
        let has_locked = keygen.is_ok_and(|s| s.success());

        let server = testserver::start(5, Some(key.public_key().clone())).unwrap();
        let echo = echo_server();
        let none = SshCredentials::default();
        let mut t = target(server.port, SshAuth::Key);
        t.key_file = plain.display().to_string();
        let e = open(&t, "127.0.0.1", echo, &known(dir.path()), &none)
            .err()
            .unwrap();
        let creds = SshCredentials {
            secret: None,
            trust_fingerprint: Some(shown_fingerprint(&e)),
        };
        let tunnel = open(&t, "127.0.0.1", echo, &known(dir.path()), &creds).unwrap();
        tunnel.permit();
        assert_eq!(ask(tunnel.port(), "k\n").unwrap(), "echo: k\n");

        // without ssh-keygen on this machine the encrypted key is not tested
        if has_locked {
            t.key_file = locked.display().to_string();
            let e = open(&t, "127.0.0.1", echo, &known(dir.path()), &none)
                .err()
                .unwrap();
            assert_eq!(e.code, ErrorCode::SshSecretRequired);
            assert!(e.message.contains("passphrase needed"));
            let wrong = SshCredentials {
                secret: Some(Secret::new("wrong")),
                trust_fingerprint: None,
            };
            let e = open(&t, "127.0.0.1", echo, &known(dir.path()), &wrong)
                .err()
                .unwrap();
            assert!(e.message.contains("wrong passphrase"));
            let right = SshCredentials {
                secret: Some(Secret::new("open sesame")),
                trust_fingerprint: None,
            };
            open(&t, "127.0.0.1", echo, &known(dir.path()), &right).unwrap();
        }

        // a key the server does not know, and no key file at all
        let foreign = dir.path().join("id_foreign");
        let other = testserver::host_key(78);
        std::fs::write(
            &foreign,
            other.to_openssh(LineEnding::LF).unwrap().as_bytes(),
        )
        .unwrap();
        t.key_file = foreign.display().to_string();
        let e = open(&t, "127.0.0.1", echo, &known(dir.path()), &none)
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::AuthFailed);
        t.key_file = dir.path().join("nothing").display().to_string();
        let e = open(&t, "127.0.0.1", echo, &known(dir.path()), &none)
            .err()
            .unwrap();
        assert_eq!(e.code, ErrorCode::NotFound);
    }

    #[test]
    fn says_when_the_ssh_server_is_not_there_and_what_a_target_needs() {
        let dir = tempdir().unwrap();
        // a port nobody listens on
        let free = std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let e = open(
            &target(free, SshAuth::Password),
            "127.0.0.1",
            1,
            &known(dir.path()),
            &with_password(),
        )
        .err()
        .unwrap();
        assert_eq!(e.code, ErrorCode::ConnectionFailed);
        let mut t = target(22, SshAuth::Agent);
        t.user = " ".into();
        let e = open(
            &t,
            "db",
            5432,
            &known(dir.path()),
            &SshCredentials::default(),
        )
        .err()
        .unwrap();
        assert_eq!(e.code, ErrorCode::InvalidProfile);
        assert_eq!(target(0, SshAuth::Agent).port_or_default(), 22);
        assert_eq!(target(2222, SshAuth::Agent).label(), "e2e@127.0.0.1:2222");
    }
}
