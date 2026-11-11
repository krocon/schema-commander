//! An SSH server inside the test process (after log-commander's): password and public-key logins, and
//! `direct-tcpip` channels that it joins with real TCP connections – nothing else. Tests only.

use crate::db::runtime;
use russh::Channel;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{Auth, Msg, Server as _, Session};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const USER: &str = "e2e";
pub const PASSWORD: &str = "testSecretQx7-tunnel";

#[derive(Default)]
pub struct Counters {
    pub logins: AtomicUsize,
    pub refused: AtomicUsize,
    /// `direct-tcpip` channels opened.
    pub tunnels: AtomicUsize,
}

pub struct TestSsh {
    pub port: u16,
    pub host_key: PrivateKey,
    pub counters: Arc<Counters>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestSsh {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A host key that is the same for the same seed.
pub fn host_key(seed: u8) -> PrivateKey {
    let pair = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]);
    PrivateKey::from(pair)
}

/// Starts a server on a free port of `127.0.0.1`. `client_key`: the public key it accepts for [`USER`].
pub fn start(seed: u8, client_key: Option<PublicKey>) -> std::io::Result<TestSsh> {
    let key = host_key(seed);
    let config = Arc::new(russh::server::Config {
        keys: vec![key.clone()],
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        ..Default::default()
    });
    let counters = Arc::new(Counters::default());
    let mut server = SshServer {
        client_key,
        counters: Arc::clone(&counters),
    };
    let listener = runtime().block_on(tokio::net::TcpListener::bind(("127.0.0.1", 0)))?;
    let port = listener.local_addr()?.port();
    let task = runtime().spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    Ok(TestSsh {
        port,
        host_key: key,
        counters,
        task,
    })
}

#[derive(Clone)]
struct SshServer {
    client_key: Option<PublicKey>,
    counters: Arc<Counters>,
}

impl russh::server::Server for SshServer {
    type Handler = SshSession;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> SshSession {
        SshSession {
            client_key: self.client_key.clone(),
            counters: Arc::clone(&self.counters),
        }
    }
}

struct SshSession {
    client_key: Option<PublicKey>,
    counters: Arc<Counters>,
}

impl SshSession {
    fn verdict(&self, ok: bool) -> Auth {
        if ok {
            self.counters.logins.fetch_add(1, Ordering::SeqCst);
            Auth::Accept
        } else {
            self.counters.refused.fetch_add(1, Ordering::SeqCst);
            Auth::reject()
        }
    }
}

impl russh::server::Handler for SshSession {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(self.verdict(user == USER && password == PASSWORD))
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let ok = user == USER
            && self
                .client_key
                .as_ref()
                .is_some_and(|k| k.key_data() == key.key_data());
        Ok(self.verdict(ok))
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Ok(port) = u16::try_from(port_to_connect) else {
            return Ok(());
        };
        // a target that is not there refuses the channel (the reply is dropped)
        let Ok(mut target) = tokio::net::TcpStream::connect((host_to_connect, port)).await else {
            return Ok(());
        };
        self.counters.tunnels.fetch_add(1, Ordering::SeqCst);
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
        });
        Ok(())
    }
}
