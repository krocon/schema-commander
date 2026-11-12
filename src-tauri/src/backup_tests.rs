use super::*;
use std::sync::Mutex;
use tempfile::tempdir;

fn endpoint(kind: DbKind) -> Endpoint {
    Endpoint {
        kind,
        host: "db.example".into(),
        port: 0,
        user: "app user".into(),
        database: "shop".into(),
        password: Some(Secret::new("pa\"ss\\word")),
        tls: TlsMode::Off,
        ca_file: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        maria_client: false,
    }
}

fn table(schema: &str, table: &str) -> TableName {
    TableName {
        schema: schema.into(),
        table: table.into(),
    }
}

#[test]
fn finds_a_tool_in_the_path_then_in_the_usual_folders() {
    let home = PathBuf::from("/home/u");
    let path = std::env::join_paths(["/opt/tools", "relative/bin", "/usr/bin"]).unwrap();
    let have =
        |wanted: &'static [&'static str]| move |p: &Path| wanted.iter().any(|w| p == Path::new(w));
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let in_path = format!("/opt/tools/pg_dump{suffix}");
    let leaked: &'static str = Box::leak(in_path.clone().into_boxed_str());
    let found = find(
        Tool::PgDump,
        None,
        Some(path.as_os_str()),
        Some(&home),
        &have(Box::leak(Box::new([leaked]))),
    );
    assert_eq!(found.unwrap(), PathBuf::from(&in_path));
    // a relative folder of the PATH is never searched
    let relative: &'static str =
        Box::leak(format!("relative/bin/pg_dump{suffix}").into_boxed_str());
    let none = find(
        Tool::PgDump,
        None,
        Some(path.as_os_str()),
        None,
        &have(Box::leak(Box::new([relative]))),
    );
    assert_eq!(none.unwrap_err().code, ErrorCode::ProgramNotFound);
    // MariaDB ships the tool under its own name
    let maria: &'static str = Box::leak(format!("/usr/bin/mariadb-dump{suffix}").into_boxed_str());
    let found = find(
        Tool::MysqlDump,
        None,
        Some(path.as_os_str()),
        None,
        &have(Box::leak(Box::new([maria]))),
    );
    assert_eq!(found.unwrap(), PathBuf::from(maria));
    // nothing anywhere
    let nothing = find(Tool::Psql, None, None, Some(&home), &|_| false);
    assert_eq!(nothing.unwrap_err().code, ErrorCode::ProgramNotFound);
}

#[test]
fn a_path_that_was_set_must_be_that_program() {
    let all = |_: &Path| true;
    let root = if cfg!(windows) {
        "C:\\tools\\"
    } else {
        "/tools/"
    };
    let ok = format!("{root}pg_dump");
    assert_eq!(
        find(Tool::PgDump, Some(&ok), None, None, &all).unwrap(),
        PathBuf::from(&ok)
    );
    for bad in [
        format!("{root}rm"),
        format!("{root}psql"),
        "pg_dump".to_owned(),
        "./pg_dump".to_owned(),
    ] {
        let failed = find(Tool::PgDump, Some(&bad), None, None, &all);
        assert_eq!(
            failed.unwrap_err().code,
            ErrorCode::ProgramNotFound,
            "{bad}"
        );
    }
    // set, but not there
    assert!(find(Tool::PgDump, Some(&ok), None, None, &|_| false).is_err());
    // blank = not set
    assert!(find(Tool::PgDump, Some("  "), None, None, &|_| false).is_err());
}

#[test]
fn reads_the_major_version() {
    for (text, want) in [
        ("pg_dump (PostgreSQL) 18.1 (Homebrew)", Some(18)),
        ("mysqldump  Ver 8.0.36 for macos14 on arm64", Some(8)),
        ("mariadb-dump from 11.4.2-MariaDB, client 10.19", Some(11)),
        ("PostgreSQL 16.3 on aarch64-unknown-linux-gnu", Some(16)),
        ("MariaDB 10.11.6", Some(10)),
        ("nothing", None),
        ("", None),
    ] {
        assert_eq!(major_version(text), want, "{text}");
    }
}

#[test]
fn pg_dump_gets_its_values_joined_to_the_options_and_no_password() {
    let spec = DumpSpec {
        format: DumpFormat::Custom,
        content: Content::Structure,
        no_owner: true,
        inserts: true,
        schemas: vec!["-evil".into(), "my \"schema\"".into()],
        tables: vec![table("s", "--table"), table("", "t; rm -rf /")],
        ..DumpSpec::default()
    };
    let target = Path::new("/backups/-file name.dump");
    let i = dump(&endpoint(DbKind::Postgres), &spec, target).unwrap();
    assert_eq!(i.tool, Tool::PgDump);
    assert_eq!(
        i.args,
        [
            "--host=db.example",
            "--port=5432",
            "--username=app user",
            "--dbname=shop",
            "--no-password",
            "--format=custom",
            "--file=/backups/-file name.dump.sc-part",
            "--schema-only",
            "--no-owner",
            "--no-privileges",
            "--inserts",
            "--schema=\"-evil\"",
            "--schema=\"my \"\"schema\"\"\"",
            "--table=\"s\".\"--table\"",
            "--table=\"t; rm -rf /\"",
        ]
    );
    // every argument is an option with its value: nothing a name could turn into another option
    assert!(i.args.iter().all(|a| a.starts_with("--")));
    // the password: in the environment of the process, in no argument
    assert!(!i.args.iter().any(|a| a.contains("pa\"ss")));
    let env: Vec<(&str, &str)> = i.env.iter().map(|(k, v)| (*k, v.expose())).collect();
    assert_eq!(
        env,
        [("PGSSLMODE", "disable"), ("PGPASSWORD", "pa\"ss\\word")]
    );
    assert!(i.defaults.is_none());
    // pg_dump writes the archive itself
    assert_eq!(i.stdout_to, None);
    // written beside the target, put in its place when it is whole
    assert_eq!(i.creates, Some(part_of(target)));
    assert_eq!(i.replaces.as_deref(), Some(target));
    assert!(!i.gzip);
}

#[test]
fn a_text_backup_of_postgres_is_written_by_us() {
    let spec = DumpSpec {
        gzip: true,
        ..DumpSpec::default()
    };
    let target = Path::new("/backups/shop.sql.gz");
    let i = dump(&endpoint(DbKind::Postgres), &spec, target).unwrap();
    assert!(i.args.contains(&"--format=plain".to_owned()));
    assert!(!i.args.iter().any(|a| a.starts_with("--file")));
    assert_eq!(i.stdout_to, Some(part_of(target)));
    assert!(i.gzip);
}

#[test]
fn mysqldump_gets_names_behind_a_double_dash_and_the_password_in_a_file() {
    let spec = DumpSpec {
        content: Content::Data,
        inserts: true,
        tables: vec![table("", "--all-databases"), table("shop", "orders")],
        ..DumpSpec::default()
    };
    let target = Path::new("/backups/shop.sql");
    let i = dump(&endpoint(DbKind::Mysql), &spec, target).unwrap();
    assert_eq!(i.tool, Tool::MysqlDump);
    assert_eq!(
        i.args,
        [
            "--host=db.example",
            "--port=3306",
            "--user=app user",
            "--protocol=TCP",
            "--ssl-mode=DISABLED",
            "--single-transaction",
            "--routines",
            "--triggers",
            "--default-character-set=utf8mb4",
            "--no-create-info",
            "--skip-extended-insert",
            "--",
            "shop",
            "--all-databases",
            "orders",
        ]
    );
    assert!(i.env.is_empty());
    assert_eq!(
        i.defaults.as_ref().map(Secret::expose),
        Some("[client]\npassword=\"pa\\\"ss\\\\word\"\n")
    );
    assert_eq!(i.stdout_to, Some(part_of(target)));
    // what mysqldump cannot do
    for bad in [
        DumpSpec {
            format: DumpFormat::Custom,
            ..DumpSpec::default()
        },
        DumpSpec {
            schemas: vec!["other".into()],
            ..DumpSpec::default()
        },
        DumpSpec {
            tables: vec![table("other", "t")],
            ..DumpSpec::default()
        },
    ] {
        assert!(dump(&endpoint(DbKind::Mysql), &bad, target).is_err());
    }
}

#[test]
fn refuses_values_that_are_no_argument() {
    let target = Path::new("/backups/x.sql");
    for change in [
        (|e: &mut Endpoint| e.host = "a\nb".into()) as fn(&mut Endpoint),
        |e| e.user = String::new(),
        |e| e.database = "db\0".into(),
    ] {
        for kind in [DbKind::Postgres, DbKind::Mysql] {
            let mut e = endpoint(kind);
            change(&mut e);
            assert!(dump(&e, &DumpSpec::default(), target).is_err(), "{kind:?}");
        }
    }
    let bad_table = DumpSpec {
        tables: vec![table("s", "a\tb")],
        ..DumpSpec::default()
    };
    assert!(dump(&endpoint(DbKind::Postgres), &bad_table, target).is_err());
    assert!(
        dump(
            &endpoint(DbKind::Postgres),
            &DumpSpec::default(),
            Path::new("/x/a\nb")
        )
        .is_err()
    );
    // no tool for these: the simple export is theirs
    for kind in [DbKind::Sqlserver, DbKind::Sqlite] {
        assert!(dump(&endpoint(kind), &DumpSpec::default(), target).is_err());
    }
}

#[test]
fn restoring_picks_the_program_by_the_file() {
    let spec = RestoreSpec {
        clean: true,
        single_transaction: true,
        stop_on_error: true,
        no_owner: true,
    };
    let file = Path::new("/backups/-shop.dump");
    let archive = restore(&endpoint(DbKind::Postgres), &spec, FileKind::PgCustom, file).unwrap();
    assert_eq!(archive.tool, Tool::PgRestore);
    assert_eq!(
        archive.args[5..],
        [
            "--clean",
            "--if-exists",
            "--single-transaction",
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
            "--",
            "/backups/-shop.dump",
        ]
    );
    assert!(archive.stdin_from.is_none());
    let text = restore(&endpoint(DbKind::Postgres), &spec, FileKind::SqlGzip, file).unwrap();
    assert_eq!(text.tool, Tool::Psql);
    assert!(text.args.contains(&"--set=ON_ERROR_STOP=1".to_owned()));
    assert!(text.args.contains(&"--no-psqlrc".to_owned()));
    // the file is fed to it: it is in no argument
    assert!(!text.args.iter().any(|a| a.contains("shop.dump")));
    assert_eq!(text.stdin_from.as_deref(), Some(file));
    assert!(text.gzip);
    let my = restore(
        &endpoint(DbKind::Mysql),
        &RestoreSpec::default(),
        FileKind::Sql,
        file,
    )
    .unwrap();
    assert_eq!(my.tool, Tool::Mysql);
    assert!(my.args.contains(&"--force".to_owned()));
    assert!(my.args.contains(&"--database=shop".to_owned()));
    assert!(my.defaults.is_some());
    assert!(restore(&endpoint(DbKind::Mysql), &spec, FileKind::PgCustom, file).is_err());
    assert!(restore(&endpoint(DbKind::Sqlite), &spec, FileKind::Sql, file).is_err());
    // nothing that restores creates a file to remove
    assert!(archive.creates.is_none() && text.creates.is_none() && my.creates.is_none());
}

#[test]
fn knows_a_backup_by_its_first_bytes() {
    let dir = tempdir().unwrap();
    let write = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    };
    assert_eq!(
        file_kind(&write("a.dump", b"PGDMP\x01\x0e")).unwrap(),
        FileKind::PgCustom
    );
    assert_eq!(
        file_kind(&write("a.gz", &[0x1f, 0x8b, 8, 0])).unwrap(),
        FileKind::SqlGzip
    );
    assert_eq!(
        file_kind(&write("a.sql", b"-- dump\nCREATE")).unwrap(),
        FileKind::Sql
    );
    assert_eq!(file_kind(&write("empty", b"")).unwrap(), FileKind::Sql);
    let folder = dir.path().join("d");
    std::fs::create_dir(&folder).unwrap();
    assert!(file_kind(&folder).is_err());
    std::fs::write(folder.join("toc.dat"), b"x").unwrap();
    assert_eq!(file_kind(&folder).unwrap(), FileKind::PgDirectory);
    assert!(file_kind(&dir.path().join("missing")).is_err());
}

fn invocation(tool: Tool, args: &[&str]) -> Invocation {
    Invocation {
        tool,
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        env: Vec::new(),
        defaults: None,
        stdout_to: None,
        stdin_from: None,
        gzip: false,
        creates: None,
        replaces: None,
    }
}

#[cfg(unix)]
mod processes {
    use super::*;

    fn heard(program: &str, i: &Invocation, private: &Path) -> (AppResult<Done>, Vec<String>) {
        let lines = Mutex::new(Vec::new());
        let done = run(
            Path::new(program),
            i,
            private,
            &|line| lines.lock().unwrap().push(line),
            &|| false,
        );
        (done, lines.into_inner().unwrap())
    }

    #[test]
    fn the_output_of_a_backup_goes_to_the_file_also_compressed() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("in.sql");
        let text = "CREATE TABLE t (id int);\n".repeat(20_000);
        std::fs::write(&source, &text).unwrap();
        for gzip in [false, true] {
            let target = dir.path().join(if gzip { "out.sql.gz" } else { "out.sql" });
            let mut i = invocation(Tool::PgDump, &[source.to_str().unwrap()]);
            i.stdout_to = Some(target.clone());
            i.creates = Some(target.clone());
            i.gzip = gzip;
            let (done, said) = heard("/bin/cat", &i, dir.path());
            assert_eq!(done.unwrap().bytes, text.len() as u64);
            assert!(said.is_empty());
            let written = std::fs::read(&target).unwrap();
            if gzip {
                assert!(written.len() < text.len() / 10);
                let mut back = String::new();
                flate2::read::GzDecoder::new(&written[..])
                    .read_to_string(&mut back)
                    .unwrap();
                assert_eq!(back, text);
            } else {
                assert_eq!(written, text.as_bytes());
            }
        }
    }

    #[test]
    fn a_file_to_restore_is_fed_to_the_program_also_from_gzip() {
        let dir = tempdir().unwrap();
        let text = "INSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\n";
        let plain = dir.path().join("in.sql");
        std::fs::write(&plain, text).unwrap();
        let packed = dir.path().join("in.sql.gz");
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(text.as_bytes()).unwrap();
        std::fs::write(&packed, gz.finish().unwrap()).unwrap();
        for (file, gzip) in [(&plain, false), (&packed, true)] {
            let mut i = invocation(Tool::Psql, &[]);
            i.stdin_from = Some(file.clone());
            i.gzip = gzip;
            // `cat` gives back what it is fed: heard as lines
            let (done, said) = heard("/bin/cat", &i, dir.path());
            assert_eq!(done.unwrap().bytes, text.len() as u64);
            assert_eq!(
                said,
                ["INSERT INTO t VALUES (1);", "INSERT INTO t VALUES (2);"]
            );
        }
    }

    #[test]
    fn stopping_ends_the_process_and_removes_the_half_file() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("half.sql");
        let mut i = invocation(Tool::PgDump, &["30"]);
        i.stdout_to = Some(target.clone());
        i.creates = Some(target.clone());
        let begun = std::time::Instant::now();
        let asked = std::sync::atomic::AtomicU32::new(0);
        let done = run(Path::new("/bin/sleep"), &i, dir.path(), &|_| {}, &|| {
            asked.fetch_add(1, std::sync::atomic::Ordering::Relaxed) >= 2
        });
        assert_eq!(done.unwrap_err().code, ErrorCode::Cancelled);
        assert!(begun.elapsed() < std::time::Duration::from_secs(5));
        assert!(!target.exists());
    }

    #[test]
    fn a_program_that_fails_leaves_no_file_and_says_what_it_said() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("failed.sql");
        let mut i = invocation(Tool::PgDump, &["/no/such/file"]);
        i.stdout_to = Some(target.clone());
        i.creates = Some(target.clone());
        let (done, said) = heard("/bin/cat", &i, dir.path());
        let error = done.unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidQuery);
        assert!(error.message.contains("No such file"), "{}", error.message);
        assert_eq!(said.len(), 1);
        assert!(!target.exists());
        // a folder that was begun goes with what is in it
        let folder = dir.path().join("dump-dir");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("toc.dat"), b"x").unwrap();
        let mut i = invocation(Tool::PgDump, &["/no/such/file"]);
        i.creates = Some(folder.clone());
        assert!(heard("/bin/cat", &i, dir.path()).0.is_err());
        assert!(!folder.exists());
        // a program that is not there
        let missing = heard("/no/such/program", &invocation(Tool::Psql, &[]), dir.path());
        assert_eq!(missing.0.unwrap_err().code, ErrorCode::ProgramNotFound);
    }

    #[test]
    fn pg_restore_that_went_on_after_errors_is_done_with_warnings() {
        let dir = tempdir().unwrap();
        // `false` ends with 1, like pg_restore after errors it ignored
        let (done, _) = heard(
            "/usr/bin/false",
            &invocation(Tool::PgRestore, &[]),
            dir.path(),
        );
        assert_eq!(
            done.unwrap(),
            Done {
                bytes: 0,
                warnings: true
            }
        );
        assert!(
            heard("/usr/bin/false", &invocation(Tool::Psql, &[]), dir.path())
                .0
                .is_err()
        );
    }

    #[test]
    fn the_password_is_in_no_argument_no_output_and_no_file_that_stays() {
        let dir = tempdir().unwrap();
        // PostgreSQL: in the environment of the process – and should the program print it, not shown
        let mut i = invocation(Tool::Psql, &[]);
        i.env = vec![("PGPASSWORD", Secret::new("hunter2-secret"))];
        let (done, said) = heard("/usr/bin/env", &i, dir.path());
        done.unwrap();
        assert!(said.iter().any(|l| l == "PGPASSWORD=***"), "{said:?}");
        assert!(!said.iter().any(|l| l.contains("hunter2")));
        // MySQL: a file for the user alone, named by the first argument, gone afterwards
        let mut i = invocation(Tool::Mysql, &["--host=h"]);
        i.defaults = Some(Secret::new("[client]\npassword=\"x\"\n"));
        let (done, said) = heard("/bin/echo", &i, dir.path());
        done.unwrap();
        let line = &said[0];
        let path = line
            .strip_prefix("--defaults-extra-file=")
            .and_then(|l| l.strip_suffix(" --host=h"))
            .unwrap_or_else(|| panic!("{line}"));
        assert!(Path::new(path).starts_with(dir.path()));
        assert!(!Path::new(path).exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        // while the process runs the file is the user's alone
        let mut i = invocation(Tool::Mysql, &[]);
        i.defaults = Some(Secret::new("[client]\npassword=\"x\"\n"));
        let lines = Mutex::new(Vec::new());
        // `ls -l` of the folder, started with the file as its first argument: it complains about the
        // option and lists nothing – so the mode is read from a second run that names the folder
        let _ = run(
            Path::new("/bin/ls"),
            &i,
            dir.path(),
            &|l| lines.lock().unwrap().push(l),
            &|| false,
        );
        use std::os::unix::fs::PermissionsExt;
        let file = PrivateFile::write(dir.path(), &Secret::new("x")).unwrap();
        let mode = std::fs::metadata(&file.0).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        drop(file);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

/// The simple export of a SQLite database, run into an empty one, gives the same tables and rows.
#[test]
fn a_simple_export_restores_into_an_empty_database() {
    use crate::db::compare::{State, compare, snapshot};
    use crate::db::{Limits, Session, sqlite};
    let mut a = sqlite::open(&sqlite::demo_profile()).unwrap();
    a.execute_batch_for_tests(
        "CREATE TABLE x_author (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'it''s');
         CREATE TABLE x_book (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES x_author (id),
           title TEXT, price NUMERIC, cover BLOB);
         CREATE INDEX x_book_title ON x_book (title);
         INSERT INTO x_author VALUES (1, 'Ada'), (2, 'O''Brien; DROP TABLE x_book; --');
         INSERT INTO x_book VALUES (1, 1, 'Zeile\nzwei', 9.5, x'00ff10'), (2, 2, NULL, NULL, NULL);",
    );
    let only = |snap: crate::db::compare::Snapshot| crate::db::compare::Snapshot {
        tables: snap
            .tables
            .into_iter()
            .filter(|t| t.name.starts_with("x_"))
            .collect(),
        views: Vec::new(),
        triggers: Vec::new(),
        routines: Vec::new(),
        ..snap
    };
    let source = only(snapshot(&mut a, DbKind::Sqlite, "main", &|| false).unwrap());
    let dir = tempdir().unwrap();
    let target = dir.path().join("simple.sql");
    let tables = Mutex::new(Vec::new());
    let bytes = simple_export(
        DbKind::Sqlite,
        &source,
        true,
        &target,
        &mut |sql, sink| {
            a.execute(sql, Limits::rows(1_000_000), sink, &|| false)
                .map(|_| ())
        },
        &|t| tables.lock().unwrap().push(t),
        &|| false,
    )
    .unwrap();
    assert_eq!(tables.into_inner().unwrap(), ["x_author", "x_book"]);
    let text = std::fs::read_to_string(&target).unwrap();
    assert_eq!(bytes, text.len() as u64);
    assert!(text.starts_with("-- Simple export"), "{text}");
    // only the file itself is left
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);

    let mut b = sqlite::open(&sqlite::demo_profile()).unwrap();
    let statements: String = text
        .lines()
        .filter(|l| !l.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    b.execute_batch_for_tests(&statements);
    let restored = only(snapshot(&mut b, DbKind::Sqlite, "main", &|| false).unwrap());
    let differing: Vec<String> = compare(&source, &restored, &[])
        .unwrap()
        .into_iter()
        .filter(|i| i.state != State::Same)
        .map(|i| format!("{} {:?}", i.id, i.state))
        .collect();
    assert_eq!(differing, Vec::<String>::new(), "{text}");
    for sql in [
        "SELECT id, name FROM x_author ORDER BY id",
        "SELECT id, author_id, title, price, hex(cover) FROM x_book ORDER BY id",
    ] {
        let left = a.query(sql, Limits::rows(10), &|| false).unwrap();
        let right = b.query(sql, Limits::rows(10), &|| false).unwrap();
        assert_eq!(
            serde_json::to_value(&left.rows).unwrap(),
            serde_json::to_value(&right.rows).unwrap(),
            "{sql}"
        );
    }

    // stopped, or a statement that fails: no file
    let half = dir.path().join("half.sql");
    let stopped = simple_export(
        DbKind::Sqlite,
        &source,
        true,
        &half,
        &mut |_, _| Ok(()),
        &|_| {},
        &|| true,
    );
    assert_eq!(stopped.unwrap_err().code, ErrorCode::Cancelled);
    let failed = simple_export(
        DbKind::Sqlite,
        &source,
        true,
        &half,
        &mut |_, _| Err(AppError::new(ErrorCode::InvalidQuery, "no")),
        &|_| {},
        &|| false,
    );
    assert!(failed.is_err());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

// ── Security review 044 ───────────────────────────────────────────────────────────

/// H1: what was there before a run is there after a run that failed or was stopped.
#[cfg(unix)]
#[test]
fn a_failed_backup_leaves_the_old_one_alone() {
    let dir = tempdir().unwrap();
    let target = dir.path().join("shop.sql");
    std::fs::write(&target, "the backup of last week").unwrap();
    let e = endpoint(DbKind::Postgres);
    // a program that fails; one that is stopped
    for (program, args, stop) in [
        ("/bin/cat", vec!["/no/such/file"], false),
        ("/bin/sleep", vec!["30"], true),
    ] {
        let mut i = dump(&e, &DumpSpec::default(), &target).unwrap();
        i.args = args.into_iter().map(str::to_owned).collect();
        let failed = run(Path::new(program), &i, dir.path(), &|_| {}, &|| stop);
        assert!(failed.is_err());
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "the backup of last week"
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "nothing of the run stays"
        );
    }
    // a run that works replaces it
    let source = dir.path().join("in.sql");
    std::fs::write(&source, "new").unwrap();
    let mut i = dump(&e, &DumpSpec::default(), &target).unwrap();
    i.args = vec![source.to_str().unwrap().to_owned()];
    run(Path::new("/bin/cat"), &i, dir.path(), &|_| {}, &|| false).unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
}

/// H1: a folder that holds something is never the target of a backup – and never removed.
#[cfg(unix)]
#[test]
fn a_folder_that_holds_something_is_refused_and_untouched() {
    let dir = tempdir().unwrap();
    let documents = dir.path().join("Documents");
    std::fs::create_dir(&documents).unwrap();
    std::fs::write(documents.join("thesis.txt"), "years of work").unwrap();
    let spec = DumpSpec {
        format: DumpFormat::Directory,
        ..DumpSpec::default()
    };
    let i = dump(&endpoint(DbKind::Postgres), &spec, &documents).unwrap();
    let refused = run(
        Path::new("/usr/bin/false"),
        &i,
        dir.path(),
        &|_| {},
        &|| false,
    );
    assert_eq!(refused.unwrap_err().code, ErrorCode::Unsupported);
    assert_eq!(
        std::fs::read_to_string(documents.join("thesis.txt")).unwrap(),
        "years of work"
    );
    // an empty folder may be the target; a run that fails leaves it as it was
    let empty = dir.path().join("empty");
    std::fs::create_dir(&empty).unwrap();
    let i = dump(&endpoint(DbKind::Postgres), &spec, &empty).unwrap();
    assert!(
        run(
            Path::new("/usr/bin/false"),
            &i,
            dir.path(),
            &|_| {},
            &|| false
        )
        .is_err()
    );
    assert!(empty.is_dir());
}

/// M2: the tool talks to the server as safely as the connection does.
#[test]
fn the_tools_of_mysql_get_the_tls_mode_of_the_profile() {
    let target = Path::new("/backups/x.sql");
    for (tls, mysql, maria) in [
        (
            TlsMode::Off,
            vec!["--ssl-mode=DISABLED"],
            vec!["--skip-ssl"],
        ),
        (TlsMode::Prefer, vec!["--ssl-mode=PREFERRED"], vec![]),
        (TlsMode::Require, vec!["--ssl-mode=REQUIRED"], vec!["--ssl"]),
        (
            TlsMode::VerifyCa,
            vec!["--ssl-mode=VERIFY_CA"],
            vec!["--ssl", "--ssl-verify-server-cert"],
        ),
        (
            TlsMode::Verify,
            vec!["--ssl-mode=VERIFY_IDENTITY"],
            vec!["--ssl", "--ssl-verify-server-cert"],
        ),
    ] {
        for (maria_client, want) in [(false, &mysql), (true, &maria)] {
            let mut e = endpoint(DbKind::Mysql);
            e.tls = tls;
            e.maria_client = maria_client;
            let args = dump(&e, &DumpSpec::default(), target).unwrap().args;
            let got: Vec<&str> = args
                .iter()
                .map(String::as_str)
                .filter(|a| a.contains("ssl"))
                .collect();
            assert_eq!(&got, want, "{tls:?} maria={maria_client}");
        }
    }
    // PostgreSQL: its own CA and client certificate go along
    let mut e = endpoint(DbKind::Postgres);
    e.tls = TlsMode::Verify;
    e.ca_file = "/certs/ca.pem".into();
    e.client_cert = "/certs/me.pem".into();
    e.client_key = "/certs/me.key".into();
    let env = dump(&e, &DumpSpec::default(), target).unwrap().env;
    let get = |name: &str| {
        env.iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.expose().to_owned())
    };
    assert_eq!(get("PGSSLMODE").as_deref(), Some("verify-full"));
    assert_eq!(get("PGSSLROOTCERT").as_deref(), Some("/certs/ca.pem"));
    assert_eq!(get("PGSSLCERT").as_deref(), Some("/certs/me.pem"));
    assert_eq!(get("PGSSLKEY").as_deref(), Some("/certs/me.key"));
}

/// L1, L2: a database name is a name, a password one line.
#[test]
fn a_name_that_is_a_connection_string_and_a_password_of_two_lines_are_refused() {
    let target = Path::new("/backups/x.sql");
    for database in [
        "host=evil.example dbname=x",
        "postgresql://evil.example/x",
        "postgres://x",
    ] {
        let mut e = endpoint(DbKind::Postgres);
        e.database = database.into();
        assert!(
            dump(&e, &DumpSpec::default(), target).is_err(),
            "{database}"
        );
    }
    let mut e = endpoint(DbKind::Mysql);
    e.password = Some(Secret::new("pw\nplugin-dir=/tmp/evil"));
    assert!(dump(&e, &DumpSpec::default(), target).is_err());
}

/// L6: a path that was set names a program, not a script of the shell.
#[test]
fn a_tool_that_was_set_is_no_script() {
    let all = |_: &Path| true;
    let root = if cfg!(windows) {
        "C:\\tools\\"
    } else {
        "/tools/"
    };
    for bad in ["pg_dump.cmd", "pg_dump.bat", "pg_dump.sh", "pg_dump.ps1"] {
        let failed = find(
            Tool::PgDump,
            Some(&format!("{root}{bad}")),
            None,
            None,
            &all,
        );
        assert!(failed.is_err(), "{bad}");
    }
    assert!(
        find(
            Tool::PgDump,
            Some(&format!("{root}pg_dump.exe")),
            None,
            None,
            &all
        )
        .is_ok()
    );
}

/// M4: output that is not UTF-8 is heard, and does not end the run.
#[cfg(unix)]
#[test]
fn output_that_is_not_utf8_is_heard() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("latin1.txt");
    std::fs::write(&file, b"Fehler: Gr\xf6\xdfe\nzweite Zeile\n").unwrap();
    let lines = Mutex::new(Vec::new());
    let i = invocation(Tool::Psql, &[file.to_str().unwrap()]);
    run(
        Path::new("/bin/cat"),
        &i,
        dir.path(),
        &|l| lines.lock().unwrap().push(l),
        &|| false,
    )
    .unwrap();
    let lines = lines.into_inner().unwrap();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(lines[0].starts_with("Fehler: Gr"));
    assert_eq!(lines[1], "zweite Zeile");
}
