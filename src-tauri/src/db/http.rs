//! What the drivers that speak HTTP share (ClickHouse, Trino …): the client with the TLS settings of the
//! profile, the address of the server, errors of the transport, and percent-encoding.

use super::{Profile, TlsMode, clean};
use crate::error::{AppError, AppResult, ErrorCode};
use ureq::Agent;
use ureq::tls::{Certificate, ClientCert, PrivateKey, RootCerts, TlsConfig};

pub fn transport(on: &str, e: &ureq::Error) -> AppError {
    let said = clean(&e.to_string());
    let lower = said.to_lowercase();
    let code = if lower.contains("certificate") || lower.contains("tls") {
        ErrorCode::TlsFailed
    } else if matches!(e, ureq::Error::Timeout(_)) {
        ErrorCode::Timeout
    } else {
        ErrorCode::ConnectionFailed
    };
    AppError::new(code, format!("{on}: {said}"))
}

fn tls(profile: &Profile) -> AppResult<TlsConfig> {
    let read = |path: &str| {
        std::fs::read(path).map_err(|e| AppError::new(ErrorCode::TlsFailed, format!("{path}: {e}")))
    };
    let bad = |what: &str, e: ureq::Error| {
        AppError::new(
            ErrorCode::TlsFailed,
            format!("{what}: {}", clean(&e.to_string())),
        )
    };
    let mut config = TlsConfig::builder();
    // HTTPS has no „check the certificate but not the name“: both are checked or nothing is
    if profile.tls.unchecked() {
        config = config.disable_verification(true);
    }
    let ca = profile.ca_file.trim();
    if !ca.is_empty() {
        let pem = read(ca)?;
        let certs = ureq::tls::parse_pem(&pem)
            .filter_map(|item| match item {
                Ok(ureq::tls::PemItem::Certificate(c)) => Some(Ok(c)),
                Ok(_) => None,
                Err(e) => Some(Err(bad(ca, e))),
            })
            .collect::<AppResult<Vec<Certificate<'static>>>>()?;
        if certs.is_empty() {
            return Err(AppError::new(
                ErrorCode::TlsFailed,
                format!("{ca}: no certificate in this file"),
            ));
        }
        config = config.root_certs(RootCerts::new_with_certs(&certs));
    }
    let cert = profile.client_cert.trim();
    if !cert.is_empty() {
        let chain = Certificate::from_pem(&read(cert)?).map_err(|e| bad(cert, e))?;
        let key_file = profile.client_key.trim();
        let key = PrivateKey::from_pem(&read(key_file)?).map_err(|e| bad(key_file, e))?;
        config = config.client_cert(Some(ClientCert::new_with_certs(&[chain], key)));
    }
    Ok(config.build())
}

/// The client of a profile: no redirects are followed, a status is no error of the transport.
pub fn agent(profile: &Profile) -> AppResult<Agent> {
    super::install_crypto();
    let mut config = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(super::CONNECT_TIMEOUT))
        .user_agent("schema-commander")
        .max_redirects(0);
    if profile.tls != TlsMode::Off {
        config = config.https_only(true).tls_config(tls(profile)?);
    }
    Ok(config.build().new_agent())
}

/// `http://host:port` or `https://…` of a profile, without a slash at its end.
pub fn base(profile: &Profile) -> String {
    let host = profile.host.trim();
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    format!(
        "{}://{host}:{}",
        if profile.tls == TlsMode::Off {
            "http"
        } else {
            "https"
        },
        profile.port_or_default()
    )
}

/// A text for a URL or a header that is read as one: everything but letters, digits and `-._~` as `%XX`.
pub fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_what_a_url_would_read_as_its_own() {
        assert_eq!(encode("a b+c=d&e%/ü"), "a%20b%2Bc%3Dd%26e%25%2F%C3%BC");
        assert_eq!(encode("plain-._~09"), "plain-._~09");
    }
}
