use super::*;

fn never() -> bool {
    false
}

fn fmt(sql: &str, dialect: Dialect) -> String {
    format(sql, dialect, &Style::default(), Mode::Format, false, &never).expect(sql)
}

const CORPUS: &[(Dialect, &str)] = &[
    (
        Dialect::Postgres,
        "select a,b,c from t where x=1 and y='a b' order by a desc limit 10",
    ),
    (
        Dialect::Postgres,
        "with recent as (select * from orders where created_at > now() - interval '7 days'), big as (select customer_id, sum(total) as total from recent group by customer_id having sum(total) > 1000) select c.name, b.total from big b join customers c on c.id = b.customer_id left join regions r on r.id = c.region_id and r.active order by b.total desc",
    ),
    (
        Dialect::Postgres,
        "select id, row_number() over (partition by customer_id order by created_at desc rows between unbounded preceding and current row) as rn, sum(total) over w from orders window w as (partition by customer_id)",
    ),
    (
        Dialect::Postgres,
        "select case when a > 1 then 'big' when a between 0 and 1 and b is not null then 'small' else 'none' end as size, case x when 1 then 'one' else 'other' end from t",
    ),
    (
        Dialect::Postgres,
        "select * from t where id in (select id from u where u.x = t.x and exists (select 1 from v where v.id = u.id)) or t.name ilike '%a%'",
    ),
    (
        Dialect::Postgres,
        "merge into target t using source s on s.id = t.id when matched and s.deleted then delete when matched then update set name = s.name, total = s.total when not matched then insert (id, name) values (s.id, s.name)",
    ),
    (
        Dialect::Postgres,
        "create function f(a int) returns int as $body$ begin return a + 1; end; $body$ language plpgsql; select f(1)::text, $$it's$$, E'a\\'b', U&'d\\0061t'",
    ),
    (
        Dialect::Postgres,
        "select /*+ IndexScan(t) */ a -- first\n, b /* second */ from t -- the table\nwhere a = -1 and b = 1e-5 and c - -d > 0 and j->>'k' = 'v' and tags @> array['a','b'] and a<>b",
    ),
    (
        Dialect::Postgres,
        "insert into t (a, b, c) values (1, 'x', null), (2, 'y', default) on conflict (a) do update set b = excluded.b returning *",
    ),
    (
        Dialect::Postgres,
        "create table if not exists public.orders (id bigint generated always as identity primary key, customer_id bigint not null references customers(id) on delete cascade, total numeric(12,2) default 0 check (total >= 0), created_at timestamp with time zone default now(), unique (customer_id, created_at))",
    ),
    (
        Dialect::Postgres,
        "select a from user where x is distinct from y; update t set a = 1 where id = 2; delete from t where id = 3;",
    ),
    (
        Dialect::Postgres,
        "select 'a'\n'b', \"select\".\"from\" from \"select\" where id in (1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40)",
    ),
    (Dialect::Postgres, "select a, from where and ( select"),
    (
        Dialect::Postgres,
        "create view v as select a, count(*) filter (where b > 0) as n, string_agg(c, ',' order by c) from t group by a",
    ),
    (
        Dialect::Mysql,
        "delimiter //\ncreate procedure p(in n int) begin declare i int default 0; if n > 10 then set i = 1; elseif n > 5 then set i = 2; else set i = 3; end if; while i < n do insert into t (a) values (i); set i = i + 1; end while; select case i when 1 then 'a' else 'b' end; end //\ndelimiter ;\nselect 1;",
    ),
    (
        Dialect::Mysql,
        "select `a`, \"str\\\"ing\", 'it\\'s' # comment\nfrom `my table` t straight_join u on u.id = t.id where t.a <=> u.a and t.b like 'x%' limit 5, 10",
    ),
    (
        Dialect::Mysql,
        "insert into t (a, b) values (1, 2) on duplicate key update b = values(b); select @x := 1, @@session.sql_mode, _utf8mb4'abc', 'root'@'localhost'",
    ),
    (
        Dialect::Sqlserver,
        "create procedure dbo.p @id int, @name nvarchar(50) = N'x' as begin set nocount on; begin try select top 10 [a b], [c]]d] from dbo.[t] with (nolock) where id = @id end try begin catch print error_message() end catch if @id > 1 begin select 1 end else begin select 2 end end\ngo\nselect * from #tmp cross apply dbo.f(#tmp.id) x\nGO 2\n",
    ),
    (
        Dialect::Sqlserver,
        "merge dbo.t as t using (select 1 as id) s on s.id = t.id when matched then update set t.a = 1 when not matched by target then insert (id) values (s.id) output inserted.*;",
    ),
    (
        Dialect::Sqlserver,
        "declare @a int = 1 set @a += 2 select @a, @@rowcount update t set a = @a where id = 1 /* outer /* nested */ still */",
    ),
    (
        Dialect::Sqlite,
        "create trigger trg after update of a on t for each row when new.a > 0 begin update u set n = n + 1 where id = new.id; insert into log (msg) values ('x;y'); end; select [a], `b`, \"c\" from t",
    ),
    (
        Dialect::Sqlite,
        "begin; insert into t values (1, x'ABCD'); commit; begin transaction; select 1; end;",
    ),
    (
        Dialect::Sqlite,
        "select a from t union all select b from u except select c from v order by 1",
    ),
];

fn styles() -> Vec<Style> {
    let d = Style::default();
    vec![
        d,
        Style {
            keyword_case: KeywordCase::Lower,
            indent: 2,
            comma: Place::Leading,
            width: 40,
            and_or: Place::Trailing,
            blank_lines: 0,
        },
        Style {
            keyword_case: KeywordCase::Preserve,
            width: 400,
            blank_lines: 3,
            ..d
        },
        Style {
            width: 60,
            comma: Place::Leading,
            ..d
        },
    ]
}

/// The acceptance criteria of prompt 023: for every text, dialect and style the result has the tokens of
/// the text (checked by `format` itself – `Unsafe` would fail here) and formatting it again changes nothing.
#[test]
fn every_result_is_stable_and_has_the_same_tokens() {
    let dialects = [
        Dialect::Postgres,
        Dialect::Mysql,
        Dialect::Sqlserver,
        Dialect::Sqlite,
    ];
    for (_, sql) in CORPUS {
        for dialect in dialects {
            for style in styles() {
                for mode in [Mode::Format, Mode::Oneline, Mode::Upper, Mode::Lower] {
                    let once = match format(sql, dialect, &style, mode, false, &never) {
                        Ok(text) => text,
                        // a text of another dialect may end inside what this one reads as a string
                        Err(FormatError::Incomplete) => continue,
                        Err(e) => panic!("{e:?} for {dialect:?} {mode:?} {style:?}:\n{sql}"),
                    };
                    let twice =
                        format(&once, dialect, &style, mode, false, &never).unwrap_or_else(|e| {
                            panic!("{e:?} on the second pass {dialect:?} {mode:?}:\n{once}")
                        });
                    assert_eq!(once, twice, "not stable for {dialect:?} {mode:?} {style:?}");
                }
            }
        }
    }
}

fn with(sql: &str, dialect: Dialect, style: Style) -> String {
    format(sql, dialect, &style, Mode::Format, false, &never).expect(sql)
}

#[test]
fn a_short_statement_gets_a_line_per_clause() {
    assert_eq!(
        fmt(
            "select a,b,c from t where x=1 and y='a b' order by a desc limit 10",
            Dialect::Postgres
        ),
        "SELECT a, b, c\nFROM t\nWHERE x = 1 AND y = 'a b'\nORDER BY a DESC\nLIMIT 10"
    );
}

#[test]
fn what_does_not_fit_is_broken_entry_by_entry() {
    let style = Style {
        width: 40,
        ..Style::default()
    };
    assert_eq!(
        with(
            "select first_name, last_name, city from customers c join orders o on o.customer_id = c.id \
             where c.city = 'Berlin' and o.total > 100 or o.total is null",
            Dialect::Postgres,
            style
        ),
        "SELECT first_name, last_name, city\n\
         FROM customers c\n\
         \x20   JOIN orders o ON o.customer_id = c.id\n\
         WHERE c.city = 'Berlin'\n\
         \x20   AND o.total > 100\n\
         \x20   OR o.total IS NULL"
    );
    assert_eq!(
        with(
            "select first_name, last_name, city, country, zip from t",
            Dialect::Postgres,
            style
        ),
        "SELECT\n    first_name,\n    last_name,\n    city,\n    country,\n    zip\nFROM t"
    );
}

#[test]
fn the_style_decides_commas_and_or_indentation_and_case() {
    let style = Style {
        keyword_case: KeywordCase::Lower,
        indent: 2,
        comma: Place::Leading,
        width: 40,
        and_or: Place::Trailing,
        blank_lines: 0,
    };
    assert_eq!(
        with(
            "SELECT first_name, last_name, city, country FROM t WHERE first_name = 'a' AND last_name = 'b'; SELECT 1",
            Dialect::Postgres,
            style
        ),
        "select\n  first_name\n  , last_name\n  , city\n  , country\nfrom t\nwhere first_name = 'a' and\n  last_name = 'b';\nselect 1"
    );
    let keep = Style {
        keyword_case: KeywordCase::Preserve,
        ..Style::default()
    };
    assert_eq!(
        with("Select a From t", Dialect::Postgres, keep),
        "Select a\nFrom t"
    );
}

#[test]
fn subqueries_ctes_case_and_windows_open_when_they_are_long() {
    assert_eq!(
        fmt(
            "with big as (select customer_id, sum(total) as total from orders group by customer_id having sum(total) > 1000) \
             select c.name, case when b.total > 5000 then 'gold' when b.total between 1000 and 5000 and c.active then 'silver' else 'none' end as tier from big b join customers c on c.id = b.customer_id",
            Dialect::Postgres
        ),
        "WITH big AS (\n\
         \x20   SELECT customer_id, sum(total) AS total\n\
         \x20   FROM orders\n\
         \x20   GROUP BY customer_id\n\
         \x20   HAVING sum(total) > 1000\n\
         )\n\
         SELECT\n\
         \x20   c.name,\n\
         \x20   CASE\n\
         \x20       WHEN b.total > 5000 THEN 'gold'\n\
         \x20       WHEN b.total BETWEEN 1000 AND 5000 AND c.active THEN 'silver'\n\
         \x20       ELSE 'none'\n\
         \x20   END AS tier\n\
         FROM big b\n\
         \x20   JOIN customers c ON c.id = b.customer_id"
    );
}

#[test]
fn strings_comments_dollar_quotes_and_hints_leave_as_they_came() {
    let sql = "select /*+ IndexScan(t) */ 'a  b', $fn$ select  1 ; $fn$, E'x\\'  y', \"My  Col\" -- two  blanks\nfrom t /* a\n   b */ where x = 'it''s  ;'";
    let out = fmt(sql, Dialect::Postgres);
    for part in [
        "/*+ IndexScan(t) */",
        "'a  b'",
        "$fn$ select  1 ; $fn$",
        "E'x\\'  y'",
        "\"My  Col\"",
        "-- two  blanks\n",
        "/* a\n   b */",
        "'it''s  ;'",
    ] {
        assert!(out.contains(part), "{part} is missing in\n{out}");
    }
}

#[test]
fn blanks_that_mean_something_stay() {
    // an exponent, a sign behind a minus, operators written as one, a call and a name before a bracket
    assert_eq!(
        fmt(
            "select 1e-5,a- -1,a=-1,x<->y,count(*),f (1),a.b,a . b,:p,$1,x::int,a%b from t",
            Dialect::Postgres
        ),
        "SELECT 1e-5, a - -1, a = -1, x <-> y, count(*), f (1), a.b, a . b, :p, $1, x::int, a%b\nFROM t"
    );
    // without the line break two strings are an error in PostgreSQL
    assert_eq!(
        fmt("select 'a'\n  'b'", Dialect::Postgres),
        "SELECT 'a'\n    'b'"
    );
    assert_eq!(
        fmt("select 'u'@'h', N'x', _utf8'y'", Dialect::Mysql),
        "SELECT 'u'@'h', N'x', _utf8'y'"
    );
}

#[test]
fn names_that_look_like_keywords_keep_their_case() {
    assert_eq!(
        fmt(
            "select t.order, x.from as key from user join key on key.id = user.id",
            Dialect::Mysql
        ),
        "SELECT t.order, x.from AS key\nFROM user\n    JOIN key ON key.id = user.id"
    );
    assert_eq!(
        fmt(
            "select left(a, 1), key from t left join u on true",
            Dialect::Postgres
        ),
        "SELECT left(a, 1), key\nFROM t\n    LEFT JOIN u ON TRUE"
    );
}

#[test]
fn text_that_ends_inside_a_string_or_comment_is_refused() {
    for (dialect, sql) in [
        (Dialect::Postgres, "select 'abc"),
        (Dialect::Postgres, "select 1 /* open"),
        (Dialect::Postgres, "select $$ body"),
        (Dialect::Postgres, "select \"name"),
        (Dialect::Mysql, "select `name"),
        (Dialect::Sqlserver, "select [name"),
    ] {
        for mode in [Mode::Format, Mode::Oneline, Mode::Upper] {
            assert_eq!(
                format(sql, dialect, &Style::default(), mode, false, &never),
                Err(FormatError::Incomplete),
                "{sql}"
            );
        }
    }
    // broken SQL that is whole in its tokens is laid out, not destroyed
    assert_eq!(
        fmt("select a, from where (", Dialect::Postgres),
        "SELECT a,\nFROM where ("
    );
}

#[test]
fn client_lines_stay_lines_of_their_own() {
    assert_eq!(
        fmt(
            "select 1\ngo\nselect 2\nGO 3 -- thrice\n",
            Dialect::Sqlserver
        ),
        "SELECT 1\ngo\n\nSELECT 2\nGO 3 -- thrice\n"
    );
    // a column called `go` alone on its line would end the batch: caught, nothing returned
    let narrow = Style {
        width: 40,
        ..Style::default()
    };
    assert_eq!(
        format(
            "select first_name, last_name, city_of_birth, go from t",
            Dialect::Sqlserver,
            &narrow,
            Mode::Format,
            false,
            &never
        ),
        Err(FormatError::Unsafe)
    );
    assert_eq!(
        fmt(
            "delimiter $$\ncreate procedure p() begin select 1; end $$\ndelimiter ;",
            Dialect::Mysql
        ),
        "delimiter $$\n\nCREATE PROCEDURE p()\nBEGIN\n    SELECT 1;\nEND $$\ndelimiter ;"
    );
}

#[test]
fn one_line_and_case_only() {
    let sql = "Select a, -- note\n  b\nFrom t\nWhere x = 1;\n\nselect 2";
    let one = |mode| {
        format(
            sql,
            Dialect::Postgres,
            &Style::default(),
            mode,
            false,
            &never,
        )
        .unwrap()
    };
    assert_eq!(
        one(Mode::Oneline),
        "Select a, -- note\nb From t Where x = 1; select 2"
    );
    assert_eq!(
        one(Mode::Upper),
        "SELECT a, -- note\n  b\nFROM t\nWHERE x = 1;\n\nSELECT 2"
    );
    assert_eq!(
        one(Mode::Lower),
        "select a, -- note\n  b\nfrom t\nwhere x = 1;\n\nselect 2"
    );
}

#[test]
fn line_ends_and_the_last_line_break_follow_the_text() {
    assert_eq!(
        fmt("select a\r\nfrom t\r\n", Dialect::Postgres),
        "SELECT a\r\nFROM t\r\n"
    );
    let crlf = format(
        "select a from t",
        Dialect::Postgres,
        &Style::default(),
        Mode::Format,
        true,
        &never,
    );
    assert_eq!(crlf.unwrap(), "SELECT a\r\nFROM t");
    assert_eq!(fmt("", Dialect::Postgres), "");
    assert_eq!(fmt("  \n", Dialect::Postgres), "  \n");
    assert_eq!(
        fmt("-- only a comment", Dialect::Postgres),
        "-- only a comment"
    );
}

#[test]
fn stops_when_asked_and_refuses_what_is_nested_too_deep() {
    let sql = "select 1;\n".repeat(10);
    let stop = || true;
    assert_eq!(
        format(
            &sql,
            Dialect::Postgres,
            &Style::default(),
            Mode::Format,
            false,
            &stop
        ),
        Err(FormatError::Cancelled)
    );
    let deep = format!("select {}1{}", "(".repeat(5000), ")".repeat(5000));
    assert_eq!(
        format(
            &deep,
            Dialect::Postgres,
            &Style::default(),
            Mode::Format,
            false,
            &never
        ),
        Err(FormatError::TooDeep)
    );
}

/// A big script: every statement is laid out, in time that grows with its length (20 MB take well under
/// ten seconds in a release build; this one is small enough for a debug build).
#[test]
fn a_big_script_is_formatted_statement_by_statement() {
    let one = "insert into orders (id, customer_id, total, note) values (1, 2, 3.5, 'a ; b') on conflict (id) do nothing;\n";
    let sql = one.repeat(20_000);
    let started = std::time::Instant::now();
    let out = fmt(&sql, Dialect::Postgres);
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    assert_eq!(out.matches("INSERT INTO orders").count(), 20_000);
    assert_eq!(fmt(&out, Dialect::Postgres), out);
}
