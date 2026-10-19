//! Optional MariaDB connector (feature `db`): lists and edits markdown kept in table columns.
//! Connections, tables and columns come from `databases.toml` in the app config folder;
//! passwords live in the system keyring, never in that file.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Mutex};

use mysql::prelude::Queryable;
use mysql::{Conn, OptsBuilder, SslOpts, TxOpts, Value};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const KEYRING_SERVICE: &str = "s-nib";
const CONFIG_FILE: &str = "databases.toml";
/// Rows returned per page of the document list.
const PAGE_SIZE: u32 = 100;

/// Error prefixes the frontend tells apart.
const ERR_NO_PASSWORD: &str = "no-password";
const ERR_BAD_PASSWORD: &str = "bad-password";
const ERR_CONFLICT: &str = "conflict";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    connection: Vec<Connection>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Connection {
    name: String,
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    database: String,
    user: String,
    #[serde(default)]
    tls: bool,
    /// Extra CA certificate (PEM) for a server with a private certificate.
    tls_ca: Option<String>,
    /// Off by default: the documents open read only.
    #[serde(default)]
    write: bool,
    #[serde(default)]
    table: Vec<Table>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    name: String,
    #[serde(default = "default_id")]
    id: String,
    content: String,
    /// Column shown in the list; rows without one are listed as `#id`.
    title: Option<String>,
    /// Column set to `NOW()` on every save (e.g. Laravel `updated_at`).
    touch: Option<String>,
    /// Conditions that must all hold, each on one column: `col IS NULL`, `col IS NOT NULL`, `col = 1` or
    /// `col = 'text'`. One string or a list (e.g. `["deleted_at IS NULL", "user_id = 3"]`).
    filter: Option<OneOrMany>,
    /// Column that groups the list under headers (e.g. a course name); it sorts first.
    group: Option<String>,
    /// Column or columns the list is sorted by; the id column always comes last.
    order: Option<OneOrMany>,
}

fn default_port() -> u16 {
    3306
}

fn default_id() -> String {
    "id".to_string()
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, PartialEq)]
enum FilterValue {
    Null,
    NotNull,
    Int(i64),
    Text(String),
}

#[derive(Debug, PartialEq)]
struct Filter {
    column: String,
    value: FilterValue,
}

/// Names that are spliced into SQL (quoted): letters, digits and underscore only.
fn check_ident(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok { Ok(()) } else { Err(format!("invalid identifier: {name:?}")) }
}

fn quote(name: &str) -> String {
    format!("`{name}`")
}

fn parse_filter(text: &str) -> Result<Filter, String> {
    let text = text.trim();
    let split = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .ok_or_else(|| format!("invalid filter: {text:?}"))?;
    let (column, rest) = text.split_at(split);
    check_ident(column)?;
    let rest = rest.trim();
    let upper = rest.to_ascii_uppercase().split_whitespace().collect::<Vec<_>>().join(" ");
    let value = if upper == "IS NULL" {
        FilterValue::Null
    } else if upper == "IS NOT NULL" {
        FilterValue::NotNull
    } else if let Some(value) = rest.strip_prefix('=') {
        let value = value.trim();
        if let Ok(number) = value.parse::<i64>() {
            FilterValue::Int(number)
        } else if value.len() >= 2
            && value.starts_with('\'')
            && value.ends_with('\'')
            && !value[1..value.len() - 1].contains('\'')
        {
            FilterValue::Text(value[1..value.len() - 1].to_string())
        } else {
            return Err(format!("invalid filter value: {value:?}"));
        }
    } else {
        return Err(format!("invalid filter: {text:?}"));
    };
    Ok(Filter { column: column.to_string(), value })
}

impl Table {
    fn order_columns(&self) -> Vec<String> {
        match &self.order {
            None => Vec::new(),
            Some(OneOrMany::One(column)) => vec![column.clone()],
            Some(OneOrMany::Many(list)) => list.clone(),
        }
    }

    /// `ORDER BY` terms: group, configured columns, then the id.
    fn order_sql(&self) -> String {
        let mut columns: Vec<String> = self.group.iter().cloned().collect();
        columns.extend(self.order_columns());
        columns.push(self.id.clone());
        columns.iter().map(|column| quote(column)).collect::<Vec<_>>().join(", ")
    }

    fn filters(&self) -> Result<Vec<Filter>, String> {
        match &self.filter {
            None => Ok(Vec::new()),
            Some(OneOrMany::One(text)) => Ok(vec![parse_filter(text)?]),
            Some(OneOrMany::Many(list)) => list.iter().map(|text| parse_filter(text)).collect(),
        }
    }

    /// Configured columns, all of which must exist in the table.
    fn columns(&self) -> Result<Vec<String>, String> {
        let mut columns = vec![self.id.clone(), self.content.clone()];
        columns.extend(self.title.clone());
        columns.extend(self.touch.clone());
        columns.extend(self.group.clone());
        columns.extend(self.order_columns());
        columns.extend(self.filters()?.into_iter().map(|filter| filter.column));
        Ok(columns)
    }
}

impl Config {
    fn validate(&self) -> Result<(), String> {
        let mut names = HashSet::new();
        for connection in &self.connection {
            if !names.insert(connection.name.as_str()) {
                return Err(format!("duplicate connection: {}", connection.name));
            }
            check_ident(&connection.database)?;
            let mut tables = HashSet::new();
            for table in &connection.table {
                check_ident(&table.name)?;
                if !tables.insert(table.name.as_str()) {
                    return Err(format!("duplicate table: {}", table.name));
                }
                for column in table.columns()? {
                    check_ident(&column)?;
                }
            }
        }
        Ok(())
    }

    fn find(&self, connection: &str, table: &str) -> Result<(&Connection, &Table), String> {
        let connection = self
            .connection
            .iter()
            .find(|c| c.name == connection)
            .ok_or_else(|| format!("unknown connection: {connection}"))?;
        let table = connection
            .table
            .iter()
            .find(|t| t.name == table)
            .ok_or_else(|| format!("unknown table: {table}"))?;
        Ok((connection, table))
    }
}

fn parse_config(text: &str) -> Result<Config, String> {
    let config: Config = toml::from_str(text).map_err(|e| format!("{CONFIG_FILE}: {e}"))?;
    config.validate().map_err(|e| format!("{CONFIG_FILE}: {e}"))?;
    Ok(config)
}

fn load_config(dir: &Path) -> Result<Config, String> {
    match std::fs::read_to_string(dir.join(CONFIG_FILE)) {
        Ok(text) => parse_config(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config { connection: Vec::new() }),
        Err(e) => Err(format!("{CONFIG_FILE}: {e}")),
    }
}

/// Opaque token of the text as stored: a save only goes through while it is unchanged.
fn version_of(text: &str) -> String {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), text.len())
}

/// Escape for `LIKE ... ESCAPE '\\'` (the default).
fn like_pattern(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 2);
    out.push('%');
    for c in query.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// Size limit of the content column.
enum Limit {
    Bytes(u64),
    Chars(u64),
}

struct Schema {
    limit: Limit,
}

/// Checks that every configured column exists and finds the size limit of the content column.
fn load_schema(conn: &mut Conn, connection: &Connection, table: &Table) -> Result<Schema, String> {
    let rows: Vec<(String, String, Option<u64>)> = conn
        .exec(
            "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            (&connection.database, &table.name),
        )
        .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Err(format!("table not found: {}.{}", connection.database, table.name));
    }
    let known: HashMap<&str, (&str, Option<u64>)> =
        rows.iter().map(|(name, kind, max)| (name.as_str(), (kind.as_str(), *max))).collect();
    for column in table.columns()? {
        if !known.contains_key(column.as_str()) {
            return Err(format!("column not found: {}.{}", table.name, column));
        }
    }
    let (kind, max) = known[table.content.as_str()];
    let limit = match (kind, max) {
        ("tinytext" | "text" | "mediumtext" | "longtext", Some(max)) => Limit::Bytes(max),
        ("varchar" | "char", Some(max)) => Limit::Chars(max),
        _ => return Err(format!("content column type not supported: {kind}")),
    };
    Ok(Schema { limit })
}

fn filter_sql(filters: &[Filter], params: &mut Vec<Value>) -> String {
    if filters.is_empty() {
        return "1 = 1".to_string();
    }
    let conditions: Vec<String> = filters
        .iter()
        .map(|filter| {
            let column = quote(&filter.column);
            match &filter.value {
                FilterValue::Null => format!("{column} IS NULL"),
                FilterValue::NotNull => format!("{column} IS NOT NULL"),
                FilterValue::Int(number) => {
                    params.push(Value::from(*number));
                    format!("{column} = ?")
                }
                FilterValue::Text(text) => {
                    params.push(Value::from(text.as_str()));
                    format!("{column} = ?")
                }
            }
        })
        .collect();
    conditions.join(" AND ")
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Row {
    id: String,
    label: String,
    /// Header the row is listed under (the `group` column), if any.
    group: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Document {
    text: String,
    version: String,
    label: String,
}

/// Longest label taken from the text of a row.
const LABEL_MAX: usize = 80;

/// List label: the title column, else the first line of the text without its `#` marks, else `#id`.
fn row_label(id: &str, title: Option<String>, text: &str) -> String {
    let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let first_line = || {
        text.lines()
            .map(|line| line.trim().trim_start_matches('#').trim())
            .find(|line| !line.is_empty())
            .map(|line| line.chars().take(LABEL_MAX).collect::<String>())
    };
    title.or_else(first_line).unwrap_or_else(|| format!("#{id}"))
}

fn list_rows(
    conn: &mut Conn,
    connection: &Connection,
    table: &Table,
    query: &str,
    offset: u32,
) -> Result<Vec<Row>, String> {
    load_schema(conn, connection, table)?;
    let filters = table.filters()?;
    let mut params = Vec::new();
    let id = quote(&table.id);
    let title = table.title.as_deref().map_or("NULL".to_string(), quote);
    let mut conditions = filter_sql(&filters, &mut params);
    if !query.is_empty() {
        let pattern = like_pattern(query);
        let mut search = vec![format!("{} LIKE ?", quote(&table.content))];
        params.push(Value::from(pattern.as_str()));
        if let Some(column) = &table.title {
            search.push(format!("{} LIKE ?", quote(column)));
            params.push(Value::from(pattern.as_str()));
        }
        conditions = format!("({conditions}) AND ({})", search.join(" OR "));
    }
    let order = table.order_sql();
    let group = table.group.as_deref().map_or("NULL".to_string(), |g| format!("CAST({} AS CHAR)", quote(g)));
    // the start of the text is enough to name rows without a title
    let head = format!("LEFT({}, 400)", quote(&table.content));
    let sql = format!(
        "SELECT CAST({id} AS CHAR), {title}, {head}, {group} FROM {} WHERE {conditions} ORDER BY {order} LIMIT {PAGE_SIZE} OFFSET {offset}",
        quote(&table.name)
    );
    let rows: Vec<(String, Option<String>, Option<String>, Option<String>)> =
        conn.exec(sql, params).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, title, head, group)| {
            let label = row_label(&id, title, head.as_deref().unwrap_or_default());
            Row { id, label, group }
        })
        .collect())
}

fn read_row(conn: &mut Conn, connection: &Connection, table: &Table, id: &str) -> Result<Document, String> {
    load_schema(conn, connection, table)?;
    let mut params = vec![Value::from(id)];
    let title = table.title.as_deref().map_or("NULL".to_string(), quote);
    let sql = format!(
        "SELECT {}, {title} FROM {} WHERE {} = ? AND {}",
        quote(&table.content),
        quote(&table.name),
        quote(&table.id),
        filter_sql(&table.filters()?, &mut params)
    );
    let row: Option<(Option<String>, Option<String>)> =
        conn.exec_first(sql, params).map_err(|e| e.to_string())?;
    let (text, title) = row.ok_or_else(|| format!("row not found: {id}"))?;
    let text = text.unwrap_or_default();
    let label = row_label(id, title, &text);
    Ok(Document { version: version_of(&text), text, label })
}

/// Replaces the text of a row if it still matches `version`; returns the new version.
fn write_row(
    conn: &mut Conn,
    connection: &Connection,
    table: &Table,
    id: &str,
    text: &str,
    version: &str,
) -> Result<String, String> {
    if !connection.write {
        return Err(format!("read-only: {} is not enabled for writing", connection.name));
    }
    let schema = load_schema(conn, connection, table)?;
    match schema.limit {
        Limit::Bytes(max) if text.len() as u64 > max => {
            return Err(format!("too-large: {} bytes, the column holds {max}", text.len()));
        }
        Limit::Chars(max) if text.chars().count() as u64 > max => {
            return Err(format!("too-large: the column holds {max} characters"));
        }
        _ => {}
    }
    let mut params = vec![Value::from(id)];
    let select = format!(
        "SELECT {} FROM {} WHERE {} = ? AND {} FOR UPDATE",
        quote(&table.content),
        quote(&table.name),
        quote(&table.id),
        filter_sql(&table.filters()?, &mut params)
    );
    let mut tx = conn.start_transaction(TxOpts::default()).map_err(|e| e.to_string())?;
    let current: Option<(Option<String>,)> = tx.exec_first(select, params).map_err(|e| e.to_string())?;
    let current = current.ok_or_else(|| format!("row not found: {id}"))?.0.unwrap_or_default();
    if version_of(&current) != version {
        return Err(format!("{ERR_CONFLICT}: the row was changed elsewhere"));
    }
    let touch = table.touch.as_deref().map_or(String::new(), |c| format!(", {} = NOW()", quote(c)));
    let update = format!(
        "UPDATE {} SET {} = ?{touch} WHERE {} = ?",
        quote(&table.name),
        quote(&table.content),
        quote(&table.id)
    );
    tx.exec_drop(update, (text, id)).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(version_of(text))
}

fn connect(connection: &Connection, password: &str) -> Result<Conn, String> {
    let mut opts = OptsBuilder::new()
        .ip_or_hostname(Some(connection.host.as_str()))
        .tcp_port(connection.port)
        .user(Some(connection.user.as_str()))
        .pass(Some(password))
        .db_name(Some(connection.database.as_str()))
        .init(vec!["SET NAMES utf8mb4".to_string()]);
    if connection.tls {
        let mut ssl = SslOpts::default();
        if let Some(ca) = &connection.tls_ca {
            ssl = ssl.with_root_cert_path(Some(std::path::PathBuf::from(ca)));
        }
        opts = opts.ssl_opts(Some(ssl));
    }
    Conn::new(opts).map_err(|e| match e {
        // MariaDB error 1045: access denied (wrong user or password)
        mysql::Error::MySqlError(ref server) if server.code == 1045 => format!("{ERR_BAD_PASSWORD}: {server}"),
        other => other.to_string(),
    })
}

fn stored_password(connection: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, connection).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => ERR_NO_PASSWORD.to_string(),
        other => other.to_string(),
    })
}

/// Live connections, kept between calls and checked with a ping before reuse.
#[derive(Default, Clone)]
pub struct Db(Arc<Mutex<HashMap<String, Conn>>>);

impl Db {
    fn run<T>(
        &self,
        connection: &Connection,
        job: impl FnOnce(&mut Conn) -> Result<T, String>,
    ) -> Result<T, String> {
        let cached = self.0.lock().map_err(|e| e.to_string())?.remove(&connection.name);
        let alive = cached.and_then(|mut conn| conn.ping().is_ok().then_some(conn));
        let mut conn = match alive {
            Some(conn) => conn,
            None => connect(connection, &stored_password(&connection.name)?)?,
        };
        let result = job(&mut conn);
        // a failed job may leave the session in a bad state: reconnect next time
        if result.is_ok() {
            self.0.lock().map_err(|e| e.to_string())?.insert(connection.name.clone(), conn);
        }
        result
    }
}

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ConnectionInfo {
    name: String,
    write: bool,
    tables: Vec<String>,
}

/// Connections and tables of the config file; no network access.
#[tauri::command]
pub fn db_connections(app: AppHandle) -> Result<Vec<ConnectionInfo>, String> {
    let config = load_config(&config_dir(&app)?)?;
    Ok(config
        .connection
        .iter()
        .map(|c| ConnectionInfo {
            name: c.name.clone(),
            write: c.write,
            tables: c.table.iter().map(|t| t.name.clone()).collect(),
        })
        .collect())
}

#[tauri::command]
pub fn db_set_password(connection: String, password: String) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, &connection)
        .and_then(|entry| entry.set_password(&password))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_rows(
    app: AppHandle,
    db: State<'_, Db>,
    connection: String,
    table: String,
    query: String,
    offset: u32,
) -> Result<Vec<Row>, String> {
    let db = db.inner().clone();
    let dir = config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(&dir)?;
        let (connection, table) = config.find(&connection, &table)?;
        db.run(connection, |conn| list_rows(conn, connection, table, &query, offset))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn db_read(
    app: AppHandle,
    db: State<'_, Db>,
    connection: String,
    table: String,
    id: String,
) -> Result<Document, String> {
    let db = db.inner().clone();
    let dir = config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(&dir)?;
        let (connection, table) = config.find(&connection, &table)?;
        db.run(connection, |conn| read_row(conn, connection, table, &id))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn db_write(
    app: AppHandle,
    db: State<'_, Db>,
    connection: String,
    table: String,
    id: String,
    text: String,
    version: String,
) -> Result<String, String> {
    let db = db.inner().clone();
    let dir = config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(&dir)?;
        let (connection, table) = config.find(&connection, &table)?;
        db.run(connection, |conn| write_row(conn, connection, table, &id, &text, &version))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[[connection]]
name = "wiki"
host = "127.0.0.1"
database = "wiki"
user = "snib"

[[connection.table]]
name = "pages"
content = "body"
title = "title"
touch = "updated_at"
filter = "deleted_at IS NULL"
"#;

    #[test]
    fn parses_config_with_defaults() {
        let config = parse_config(SAMPLE).unwrap();
        let (connection, table) = config.find("wiki", "pages").unwrap();
        assert_eq!(connection.port, 3306);
        assert!(!connection.write && !connection.tls);
        assert_eq!(table.id, "id");
        assert!(config.find("wiki", "other").is_err());
    }

    #[test]
    fn accepts_a_list_of_filters() {
        let config = parse_config(&SAMPLE.replace(
            "filter = \"deleted_at IS NULL\"",
            "filter = [\"deleted_at IS NULL\", \"user_id = 3\"]",
        ))
        .unwrap();
        let (_, table) = config.find("wiki", "pages").unwrap();
        assert_eq!(table.filters().unwrap().len(), 2);
        assert!(table.columns().unwrap().contains(&"user_id".to_string()));
        let bad = SAMPLE.replace("filter = \"deleted_at IS NULL\"", "filter = [\"user_id = 3 OR 1 = 1\"]");
        assert!(parse_config(&bad).is_err());
    }

    #[test]
    fn orders_by_group_then_columns_then_id() {
        let text = SAMPLE.replace("touch = \"updated_at\"", "group = \"course\"\norder = [\"chapter_order\", \"sheet_order\"]");
        let config = parse_config(&text).unwrap();
        let (_, table) = config.find("wiki", "pages").unwrap();
        assert_eq!(table.order_sql(), "`course`, `chapter_order`, `sheet_order`, `id`");
        assert!(table.columns().unwrap().contains(&"course".to_string()));
        let (_, plain) = parse_config(SAMPLE).unwrap().find("wiki", "pages").map(|(c, t)| (c.port, t.order_sql())).unwrap();
        assert_eq!(plain, "`id`");
        assert!(parse_config(&text.replace("sheet_order", "x; y")).is_err());
    }

    #[test]
    fn rejects_unsafe_or_unknown_config() {
        let bad_table = SAMPLE.replace("name = \"pages\"", "name = \"pages`; DROP TABLE x\"");
        assert!(parse_config(&bad_table).is_err());
        let bad_column = SAMPLE.replace("body", "body, secret");
        assert!(parse_config(&bad_column).is_err());
        assert!(parse_config(&format!("{SAMPLE}\nunknown = 1")).is_err());
        let duplicate = format!("{SAMPLE}\n{SAMPLE}");
        assert!(parse_config(&duplicate).is_err());
    }

    #[test]
    fn parses_filters() {
        assert_eq!(
            parse_filter("deleted_at IS  NOT null").unwrap(),
            Filter { column: "deleted_at".into(), value: FilterValue::NotNull }
        );
        assert_eq!(
            parse_filter("kind = 'doc'").unwrap().value,
            FilterValue::Text("doc".into())
        );
        assert_eq!(parse_filter("level=3").unwrap().value, FilterValue::Int(3));
        assert!(parse_filter("a = 'x' OR 1 = 1").is_err());
        assert!(parse_filter("a = (SELECT 1)").is_err());
        assert!(parse_filter("a; DROP TABLE t IS NULL").is_err());
        assert!(parse_filter("onlycolumn").is_err());
    }

    #[test]
    fn labels_rows() {
        assert_eq!(row_label("7", Some(" Title ".into()), "# Other"), "Title");
        assert_eq!(row_label("7", None, "\n\n## Intro\nText"), "Intro");
        assert_eq!(row_label("7", Some("".into()), "# Heading"), "Heading");
        assert_eq!(row_label("7", None, " \n#\n"), "#7");
        assert_eq!(row_label("7", None, &"x".repeat(200)).chars().count(), LABEL_MAX);
    }

    #[test]
    fn escapes_like_patterns() {
        assert_eq!(like_pattern("50%_a\\"), "%50\\%\\_a\\\\%");
    }

    #[test]
    fn versions_follow_the_text() {
        assert_eq!(version_of("a"), version_of("a"));
        assert_ne!(version_of("a"), version_of("b"));
        assert_ne!(version_of(""), version_of(" "));
    }

    /// Network tests: run only when `SNIB_TEST_DB_PASSWORD` is set (user `snib` on 127.0.0.1, database `snib_test`).
    fn test_connection(write: bool) -> Option<(Connection, Conn)> {
        let password = std::env::var("SNIB_TEST_DB_PASSWORD").ok()?;
        let connection = Connection {
            name: "test".into(),
            host: "127.0.0.1".into(),
            port: 3306,
            database: "snib_test".into(),
            user: "snib".into(),
            tls: false,
            tls_ca: None,
            write,
            table: Vec::new(),
        };
        let conn = connect(&connection, &password).expect("connect to the test database");
        Some((connection, conn))
    }

    #[test]
    fn wrong_password_is_reported() {
        let Some((connection, _conn)) = test_connection(false) else { return };
        let error = connect(&connection, "definitely-wrong").err().expect("access denied");
        assert!(error.starts_with(ERR_BAD_PASSWORD), "{error}");
    }

    fn test_table(name: &str) -> Table {
        Table {
            name: name.into(),
            id: "id".into(),
            content: "body".into(),
            title: Some("title".into()),
            touch: Some("updated_at".into()),
            filter: Some(OneOrMany::One("deleted_at IS NULL".into())),
            group: None,
            order: None,
        }
    }

    #[test]
    fn lists_reads_and_writes_rows() {
        let Some((connection, mut conn)) = test_connection(true) else { return };
        let name = format!("docs_{}", std::process::id());
        let table = test_table(&name);
        conn.query_drop(format!(
            "CREATE TABLE `{name}` (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, title VARCHAR(255) NULL, \
             body TEXT NOT NULL, updated_at TIMESTAMP NULL, deleted_at TIMESTAMP NULL) \
             CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        ))
        .unwrap();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            conn.query_drop(format!(
                "INSERT INTO `{name}` (title, body, deleted_at) VALUES \
                 ('First', 'hello\\r\\nworld 100%', NULL), (NULL, 'no title', NULL), ('Gone', 'x', NOW())"
            ))
            .unwrap();

            let rows = list_rows(&mut conn, &connection, &table, "", 0).unwrap();
            assert_eq!(
                rows,
                vec![
                    Row { id: "1".into(), label: "First".into(), group: None },
                    Row { id: "2".into(), label: "no title".into(), group: None },
                ]
            );
            assert_eq!(list_rows(&mut conn, &connection, &table, "100%", 0).unwrap().len(), 1);
            let both = Table {
                filter: Some(OneOrMany::Many(vec!["deleted_at IS NULL".into(), "id = 2".into()])),
                ..test_table(&name)
            };
            let only = list_rows(&mut conn, &connection, &both, "", 0).unwrap();
            assert_eq!(only.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["2"]);
            assert!(read_row(&mut conn, &connection, &both, "1").is_err(), "filters apply to reads too");
            let grouped = Table {
                group: Some("title".into()),
                order: Some(OneOrMany::Many(vec!["id".into()])),
                ..test_table(&name)
            };
            let rows = list_rows(&mut conn, &connection, &grouped, "", 0).unwrap();
            let seen: Vec<_> = rows.iter().map(|r| (r.id.as_str(), r.group.as_deref())).collect();
            assert_eq!(seen, [("2", None), ("1", Some("First"))], "NULL group sorts first");
            assert_eq!(list_rows(&mut conn, &connection, &table, "zzz", 0).unwrap().len(), 0);

            let doc = read_row(&mut conn, &connection, &table, "1").unwrap();
            assert_eq!(doc.text, "hello\r\nworld 100%");
            assert!(read_row(&mut conn, &connection, &table, "3").is_err(), "soft deleted row is hidden");

            let version = write_row(&mut conn, &connection, &table, "1", "# new\né", &doc.version).unwrap();
            let after = read_row(&mut conn, &connection, &table, "1").unwrap();
            assert_eq!((after.text.as_str(), after.version.as_str()), ("# new\né", version.as_str()));
            let touched: Option<String> =
                conn.query_first(format!("SELECT updated_at FROM `{name}` WHERE id = 1")).unwrap();
            assert!(touched.is_some(), "touch column was set");

            let stale = write_row(&mut conn, &connection, &table, "1", "again", &doc.version).unwrap_err();
            assert!(stale.starts_with(ERR_CONFLICT), "{stale}");

            let big = "x".repeat(70_000);
            let too_large = write_row(&mut conn, &connection, &table, "1", &big, &version).unwrap_err();
            assert!(too_large.starts_with("too-large"), "{too_large}");

            let read_only = Connection { write: false, ..connection_copy(&connection) };
            let denied = write_row(&mut conn, &read_only, &table, "1", "no", &version).unwrap_err();
            assert!(denied.starts_with("read-only"), "{denied}");

            let missing = Table { content: "nope".into(), ..test_table(&name) };
            assert!(list_rows(&mut conn, &connection, &missing, "", 0).unwrap_err().contains("column not found"));
        }));
        conn.query_drop(format!("DROP TABLE `{name}`")).unwrap();
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }

    fn connection_copy(c: &Connection) -> Connection {
        Connection {
            name: c.name.clone(),
            host: c.host.clone(),
            port: c.port,
            database: c.database.clone(),
            user: c.user.clone(),
            tls: c.tls,
            tls_ca: c.tls_ca.clone(),
            write: c.write,
            table: Vec::new(),
        }
    }
}
