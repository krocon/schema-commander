//! The native menu bar (prompt 018, after files-and-folders-tauri).
//!
//! The frontend owns the menu model – every item is an action of its catalog – and sends a [`MenuSpec`]
//! with labels in the language of the window and shortcuts in the keymap notation. This module checks the
//! spec (size, depth, well-formed ids, known native items), turns safe shortcuts into native accelerators
//! and builds the Tauri menu. A chosen item comes back as its id. Pure parts (validation, accelerators) are
//! tested below; the build needs a running app.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::menu::{
    AboutMetadata, CheckMenuItemBuilder, IsMenuItem, Menu, MenuItemBuilder, MenuItemKind,
    PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Runtime};

/// Limits of a spec – a menu bar has ~100 entries; anything far beyond is a bug.
pub const MAX_NODES: usize = 600;
pub const MAX_DEPTH: usize = 3;
pub const MAX_LABEL: usize = 120;
pub const MAX_ID: usize = 80;

/// One node of a menu (`kind` tag, camelCase like all DTOs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MenuNode {
    /// An action: `id` comes back in a [`MenuEvent`].
    #[serde(rename_all = "camelCase")]
    Item {
        id: String,
        label: String,
        /// Shortcut in keymap notation (`Mod+Shift+P`), already resolved with the override.
        #[serde(default)]
        accelerator: Option<String>,
        enabled: bool,
        /// Set: a check item, ✓ when `true` (a switch such as „result at the right“).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked: Option<bool>,
    },
    Submenu {
        label: String,
        items: Vec<MenuNode>,
    },
    Separator,
    /// A native item of the OS (Edit → Copy, Quit, …), see [`PREDEFINED`].
    Predefined {
        name: String,
        /// The words of the item in the language of the window; `None` = the system's.
        #[serde(default)]
        label: Option<String>,
    },
}

/// The menu bar: top-level nodes must be submenus.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MenuSpec {
    pub menus: Vec<MenuNode>,
}

/// A chosen menu item (sent over the menu channel).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MenuEvent {
    pub id: String,
}

/// Native items the frontend may ask for.
pub const PREDEFINED: &[&str] = &[
    "about",
    "services",
    "hide",
    "hideOthers",
    "showAll",
    "quit",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
    "minimize",
    "maximize",
    "fullscreen",
    "closeWindow",
];

/// Checks form and size of a spec; the message names the first problem.
pub fn validate_spec(spec: &MenuSpec) -> Result<(), String> {
    let mut count = 0usize;
    for top in &spec.menus {
        if !matches!(top, MenuNode::Submenu { .. }) {
            return Err("top-level entries must be submenus".into());
        }
        validate_node(top, 1, &mut count)?;
    }
    Ok(())
}

/// The new state of one item of the installed menu (`set_menu_state`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MenuItemState {
    pub id: String,
    pub enabled: bool,
    /// For check items: whether it is ticked.
    #[serde(default)]
    pub checked: Option<bool>,
}

/// Checks an enabled update: well-formed ids, at most [`MAX_NODES`]; ids that the
/// installed menu does not have (an older spec) are skipped.
pub fn validate_enabled(
    items: &[MenuItemState],
    known: &HashSet<String>,
) -> Result<std::collections::HashMap<String, MenuItemState>, String> {
    if items.len() > MAX_NODES {
        return Err(format!("more than {MAX_NODES} menu entries"));
    }
    let mut out = std::collections::HashMap::new();
    for item in items {
        validate_id(&item.id)?;
        if known.contains(&item.id) {
            out.insert(item.id.clone(), item.clone());
        }
    }
    Ok(out)
}

/// Sets the enabled flags of all items of `menu` named in `wanted` (an action may
/// appear in several menus – all of them change).
pub fn apply_enabled<R: Runtime>(
    menu: &Menu<R>,
    wanted: &std::collections::HashMap<String, MenuItemState>,
) -> tauri::Result<()> {
    fn walk<R: Runtime>(
        items: Vec<MenuItemKind<R>>,
        wanted: &std::collections::HashMap<String, MenuItemState>,
    ) -> tauri::Result<()> {
        for kind in items {
            match kind {
                MenuItemKind::MenuItem(item) => {
                    if let Some(state) = wanted.get(item.id().as_ref()) {
                        item.set_enabled(state.enabled)?;
                    }
                }
                MenuItemKind::Check(item) => {
                    if let Some(state) = wanted.get(item.id().as_ref()) {
                        item.set_enabled(state.enabled)?;
                        if let Some(checked) = state.checked {
                            item.set_checked(checked)?;
                        }
                    }
                }
                MenuItemKind::Submenu(sub) => walk(sub.items()?, wanted)?,
                _ => {}
            }
        }
        Ok(())
    }
    walk(menu.items()?, wanted)
}

fn validate_node(node: &MenuNode, depth: usize, count: &mut usize) -> Result<(), String> {
    *count += 1;
    if *count > MAX_NODES {
        return Err(format!("more than {MAX_NODES} menu entries"));
    }
    match node {
        MenuNode::Item { id, label, .. } => {
            // the same action may appear in several menus – it is the same event
            validate_id(id)?;
            validate_label(label)?;
        }
        MenuNode::Submenu { label, items } => {
            if depth > MAX_DEPTH {
                return Err(format!("menus nest deeper than {MAX_DEPTH} levels"));
            }
            validate_label(label)?;
            for child in items {
                validate_node(child, depth + 1, count)?;
            }
        }
        MenuNode::Separator => {}
        MenuNode::Predefined { name, label } => {
            if !PREDEFINED.contains(&name.as_str()) {
                return Err(format!(
                    "unknown native menu item \"{}\"",
                    name.escape_debug()
                ));
            }
            if let Some(label) = label {
                validate_label(label)?;
            }
        }
    }
    Ok(())
}

/// An id is the id of an action: `A-Z`, digits and `_`, starting with a letter.
fn validate_id(id: &str) -> Result<(), String> {
    let ok = id.len() <= MAX_ID
        && id.starts_with(|c: char| c.is_ascii_uppercase())
        && id
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid menu id \"{}\"", id.escape_debug()))
    }
}

fn validate_label(label: &str) -> Result<(), String> {
    if label.trim().is_empty() || label.chars().count() > MAX_LABEL {
        return Err("a menu label is empty or too long".into());
    }
    if label.chars().any(char::is_control) {
        return Err("a menu label contains control characters".into());
    }
    Ok(())
}

/// Keys of the keymap notation that have a native accelerator (muda names).
fn native_key(key: &str) -> Option<String> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return (c.is_ascii_alphanumeric() || "`\\[],.=-';/".contains(c))
            .then(|| c.to_ascii_uppercase().to_string());
    }
    if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        return (1..=24).contains(&n).then(|| key.to_string());
    }
    const NAMED: &[&str] = &[
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "Insert",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
        "NumpadAdd",
        "NumpadSubtract",
        "NumpadMultiply",
        "NumpadDivide",
        "NumpadDecimal",
        "NumpadEnter",
    ];
    NAMED.contains(&key).then(|| key.to_string())
}

/// Native accelerator for a keymap shortcut (design 018), `None` when the menu
/// must not own the key: only one stroke with Mod/Ctrl or an F-key – plain keys,
/// Alt+letter (⌥ types characters on macOS) and chords stay with the page, else a
/// menu would take keys away from text fields.
pub fn native_accelerator(shortcut: &str, macos: bool) -> Option<String> {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() || shortcut.contains(' ') {
        return None;
    }
    // a trailing "+" key is written "Mod++" – no native name for it
    if shortcut.ends_with("++") {
        return None;
    }
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    let key = parts.pop()?;
    let (mut command, mut ctrl, mut alt, mut shift) = (false, false, false, false);
    for p in parts {
        match p {
            "Mod" => command = true,
            "Ctrl" => ctrl = true,
            "Alt" => alt = true,
            "Shift" => shift = true,
            _ => return None,
        }
    }
    let is_fkey = key.len() > 1 && key.starts_with('F') && key[1..].parse::<u8>().is_ok();
    if !(command || ctrl || is_fkey) {
        return None;
    }
    let key = native_key(key)?;
    let mut out = Vec::new();
    if command {
        out.push(if macos { "Cmd" } else { "Ctrl" });
    }
    if ctrl && (macos || !command) {
        out.push("Ctrl");
    }
    if alt {
        out.push("Alt");
    }
    if shift {
        out.push("Shift");
    }
    let mut text = out.join("+");
    if !text.is_empty() {
        text.push('+');
    }
    text.push_str(&key);
    Some(text)
}

/// Builds the native menu from a validated spec.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>, spec: &MenuSpec) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for top in &spec.menus {
        if let MenuNode::Submenu { label, items } = top {
            let sub = build_submenu(app, label, items)?;
            menu.append(&sub)?;
        }
    }
    Ok(menu)
}

fn build_submenu<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    items: &[MenuNode],
) -> tauri::Result<Submenu<R>> {
    let sub = Submenu::new(app, label, true)?;
    for node in items {
        let kind = build_node(app, node)?;
        sub.append(&kind as &dyn IsMenuItem<R>)?;
    }
    Ok(sub)
}

fn build_node<R: Runtime>(app: &AppHandle<R>, node: &MenuNode) -> tauri::Result<MenuItemKind<R>> {
    Ok(match node {
        MenuNode::Item {
            id,
            label,
            enabled,
            checked: Some(checked),
            ..
        } => MenuItemKind::Check(
            CheckMenuItemBuilder::with_id(id.clone(), label)
                .enabled(*enabled)
                .checked(*checked)
                .build(app)?,
        ),
        MenuNode::Item {
            id,
            label,
            accelerator,
            enabled,
            checked: None,
        } => {
            let accel = accelerator
                .as_deref()
                .and_then(|a| native_accelerator(a, cfg!(target_os = "macos")));
            let base = || MenuItemBuilder::with_id(id.clone(), label).enabled(*enabled);
            let item = match accel {
                // an accelerator muda rejects must not cost the whole menu
                Some(a) => base()
                    .accelerator(a)
                    .build(app)
                    .or_else(|_| base().build(app))?,
                None => base().build(app)?,
            };
            MenuItemKind::MenuItem(item)
        }
        MenuNode::Submenu { label, items } => {
            MenuItemKind::Submenu(build_submenu(app, label, items)?)
        }
        MenuNode::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        MenuNode::Predefined { name, label } => {
            MenuItemKind::Predefined(predefined(app, name, label.as_deref())?)
        }
    })
}

fn predefined<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    label: Option<&str>,
) -> tauri::Result<PredefinedMenuItem<R>> {
    match name {
        "about" => {
            let info = app.package_info();
            let meta = AboutMetadata {
                name: Some(info.name.clone()),
                version: Some(info.version.to_string()),
                ..Default::default()
            };
            PredefinedMenuItem::about(app, label, Some(meta))
        }
        "services" => PredefinedMenuItem::services(app, label),
        "hide" => PredefinedMenuItem::hide(app, label),
        "hideOthers" => PredefinedMenuItem::hide_others(app, label),
        "showAll" => PredefinedMenuItem::show_all(app, label),
        "quit" => PredefinedMenuItem::quit(app, label),
        "undo" => PredefinedMenuItem::undo(app, label),
        "redo" => PredefinedMenuItem::redo(app, label),
        "cut" => PredefinedMenuItem::cut(app, label),
        "copy" => PredefinedMenuItem::copy(app, label),
        "paste" => PredefinedMenuItem::paste(app, label),
        "selectAll" => PredefinedMenuItem::select_all(app, label),
        "minimize" => PredefinedMenuItem::minimize(app, label),
        "maximize" => PredefinedMenuItem::maximize(app, label),
        "fullscreen" => PredefinedMenuItem::fullscreen(app, label),
        "closeWindow" => PredefinedMenuItem::close_window(app, label),
        // validated before – never reached
        _ => PredefinedMenuItem::separator(app),
    }
}

/// Ids of all items of a spec (menu events for other ids are dropped).
pub fn item_ids(spec: &MenuSpec) -> HashSet<String> {
    fn walk(node: &MenuNode, out: &mut HashSet<String>) {
        match node {
            MenuNode::Item { id, .. } => {
                out.insert(id.clone());
            }
            MenuNode::Submenu { items, .. } => items.iter().for_each(|n| walk(n, out)),
            _ => {}
        }
    }
    let mut out = HashSet::new();
    spec.menus.iter().for_each(|n| walk(n, &mut out));
    out
}

/// The native menu is used on macOS; elsewhere the window draws its own menu bar (design 018 E2),
/// unless `SC_NATIVE_MENU=1` asks for the native one.
pub fn native_menu_wanted() -> bool {
    cfg!(target_os = "macos") || std::env::var("SC_NATIVE_MENU").is_ok_and(|v| v == "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> MenuNode {
        MenuNode::Item {
            id: id.into(),
            label: "Copy…".into(),
            accelerator: None,
            enabled: true,
            checked: None,
        }
    }

    fn sub(items: Vec<MenuNode>) -> MenuNode {
        MenuNode::Submenu {
            label: "File".into(),
            items,
        }
    }

    #[test]
    fn accelerators_map_mod_per_os() {
        assert_eq!(
            native_accelerator("Mod+Shift+P", true).as_deref(),
            Some("Cmd+Shift+P")
        );
        assert_eq!(
            native_accelerator("Mod+Shift+P", false).as_deref(),
            Some("Ctrl+Shift+P")
        );
        // the real Control key on macOS
        assert_eq!(
            native_accelerator("Ctrl+Q", true).as_deref(),
            Some("Ctrl+Q")
        );
        assert_eq!(
            native_accelerator("Mod+Ctrl+D", true).as_deref(),
            Some("Cmd+Ctrl+D")
        );
        assert_eq!(
            native_accelerator("Mod+Alt+Backspace", true).as_deref(),
            Some("Cmd+Alt+Backspace")
        );
        assert_eq!(native_accelerator("Mod+[", true).as_deref(), Some("Cmd+["));
        assert_eq!(native_accelerator("Mod+,", true).as_deref(), Some("Cmd+,"));
        assert_eq!(
            native_accelerator("Mod+.", false).as_deref(),
            Some("Ctrl+.")
        );
    }

    #[test]
    fn function_keys_need_no_modifier() {
        assert_eq!(native_accelerator("F5", true).as_deref(), Some("F5"));
        assert_eq!(
            native_accelerator("Shift+F8", false).as_deref(),
            Some("Shift+F8")
        );
        assert_eq!(
            native_accelerator("Alt+F7", true).as_deref(),
            Some("Alt+F7")
        );
        assert_eq!(native_accelerator("F25", true), None);
    }

    #[test]
    fn plain_keys_alt_letters_and_chords_stay_with_the_page() {
        for s in [
            "Enter",
            "Space",
            "Tab",
            "Backspace",
            "NumpadAdd",
            "Shift+ArrowDown",
            "Alt+1",
            "Alt+G",
            "Ctrl+K F6",
            "Mod++",
            "",
            "Hyper+A",
            "Mod+ContextMenu",
        ] {
            assert_eq!(native_accelerator(s, true), None, "{s}");
        }
    }

    #[test]
    fn spec_accepts_a_normal_menu() {
        let spec = MenuSpec {
            menus: vec![sub(vec![
                item("RUN_SCRIPT"),
                MenuNode::Separator,
                item("NEW_TAB"),
                MenuNode::Predefined {
                    name: "copy".into(),
                    label: Some("Kopieren".into()),
                },
                sub(vec![item("COPY_AS_CSV")]),
            ])],
        };
        assert_eq!(validate_spec(&spec), Ok(()));
        let ids = item_ids(&spec);
        assert!(ids.contains("NEW_TAB") && ids.contains("COPY_AS_CSV"));
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn spec_rejects_bad_input() {
        let bad = |menus| validate_spec(&MenuSpec { menus }).is_err();
        assert!(bad(vec![item("A")]), "top level must be a submenu");
        assert!(bad(vec![sub(vec![item("a b")])]), "space in id");
        assert!(bad(vec![sub(vec![item(&"x".repeat(81))])]));
        assert!(bad(vec![sub(vec![MenuNode::Predefined {
            name: "rm -rf".into(),
            label: None
        }])]));
        assert!(bad(vec![sub(vec![MenuNode::Predefined {
            name: "copy".into(),
            label: Some("a\u{0}b".into())
        }])]));
        // ids are action ids: capitals, digits, underscores
        for id in ["tool:edit", "run", "1A", "", "A-B", "A.B"] {
            assert!(bad(vec![sub(vec![item(id)])]), "{id}");
        }
        assert!(bad(vec![sub(vec![MenuNode::Item {
            id: "A".into(),
            label: "evil\u{7}".into(),
            accelerator: None,
            enabled: true,
            checked: None
        }])]));
        assert!(bad(vec![sub(vec![MenuNode::Item {
            id: "A".into(),
            label: "  ".into(),
            accelerator: None,
            enabled: true,
            checked: None
        }])]));
        // depth: File ▸ a ▸ b ▸ c
        assert!(bad(vec![sub(vec![sub(vec![sub(vec![sub(vec![])])])])]));
        assert!(!bad(vec![sub(vec![sub(vec![sub(vec![])])])]));
        assert!(bad(vec![sub((0..MAX_NODES).map(|_| item("A")).collect())]));
    }

    #[test]
    fn state_updates_only_for_known_ids() {
        let known: HashSet<String> = ["RUN_SCRIPT".to_string(), "TOGGLE_RESULT".to_string()].into();
        let e = |id: &str, enabled, checked| MenuItemState {
            id: id.into(),
            enabled,
            checked,
        };
        let ok = validate_enabled(
            &[
                e("RUN_SCRIPT", false, None),
                e("TOGGLE_RESULT", true, Some(true)),
            ],
            &known,
        )
        .unwrap();
        assert!(!ok["RUN_SCRIPT"].enabled);
        assert_eq!(ok["TOGGLE_RESULT"].checked, Some(true));
        assert_eq!(ok.len(), 2);
        // ids of an older menu are skipped, malformed ids and floods rejected
        assert_eq!(
            validate_enabled(&[e("GONE", true, None)], &known)
                .unwrap()
                .len(),
            0
        );
        assert!(validate_enabled(&[e("a b", true, None)], &known).is_err());
        let flood: Vec<_> = (0..=MAX_NODES)
            .map(|_| e("RUN_SCRIPT", true, None))
            .collect();
        assert!(validate_enabled(&flood, &known).is_err());
        let json = r#"[{"id":"RUN_SCRIPT","enabled":true}]"#;
        let parsed: Vec<MenuItemState> = serde_json::from_str(json).unwrap();
        assert_eq!(parsed, vec![e("RUN_SCRIPT", true, None)]);
    }

    #[test]
    fn spec_json_form() {
        let json = r#"{"menus":[{"kind":"submenu","label":"Edit","items":[
            {"kind":"predefined","name":"selectAll","label":"Alles auswählen"},
            {"kind":"predefined","name":"copy"},
            {"kind":"separator"},
            {"kind":"item","id":"SELECT_ALL","label":"Mark all","accelerator":"Mod+A","enabled":false},
            {"kind":"item","id":"X","label":"No shortcut","enabled":true}]}]}"#;
        let spec: MenuSpec = serde_json::from_str(json).unwrap();
        assert_eq!(validate_spec(&spec), Ok(()));
        let MenuNode::Submenu { items, .. } = &spec.menus[0] else {
            panic!("submenu")
        };
        assert_eq!(
            items[3],
            MenuNode::Item {
                id: "SELECT_ALL".into(),
                label: "Mark all".into(),
                accelerator: Some("Mod+A".into()),
                enabled: false,
                checked: None
            }
        );
        assert!(matches!(
            &items[4],
            MenuNode::Item {
                accelerator: None,
                ..
            }
        ));
        // a check item: `checked` only when set
        let check: MenuNode = serde_json::from_str(
            r#"{"kind":"item","id":"TOGGLE_RESULT","label":"Result","enabled":true,"checked":true}"#,
        )
        .unwrap();
        assert!(matches!(
            check,
            MenuNode::Item {
                checked: Some(true),
                ..
            }
        ));
        let plain = serde_json::to_value(&items[4]).unwrap();
        assert!(plain.get("checked").is_none());
        assert_eq!(
            serde_json::to_value(MenuEvent { id: "X".into() }).unwrap(),
            serde_json::json!({ "id": "X" })
        );
    }
}
