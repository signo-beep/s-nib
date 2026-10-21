const dialog = document.getElementById("help-dialog") as HTMLDialogElement;
const body = document.getElementById("help-body")!;

type Entry = [keys: string, label: string];

const SECTIONS: { title: string; entries: Entry[] }[] = [
  {
    title: "Document",
    entries: [
      ["Ctrl+N", "New document"],
      ["Ctrl+O", "Open file"],
      ["Ctrl+Shift+O", "Open folder"],
      ["Ctrl+S", "Save"],
      ["Ctrl+Shift+S", "Save as"],
      ["Ctrl+W", "Close the active pane"],
      ["Ctrl+/", "Source mode"],
      ["Ctrl+Shift+Y", "Add or edit the YAML front matter"],
      ["Ctrl+Shift+I", "Insert image"],
      ["Ctrl+P", "Print"],
      ["Ctrl+Shift+E", "Export as PDF"],
    ],
  },
  {
    title: "Search",
    entries: [
      ["Ctrl+F", "Find"],
      ["Ctrl+H", "Find and replace (Enter: one, Ctrl+Enter: all)"],
      ["Ctrl+Shift+H", "Search in the open folder"],
      ["Ctrl+Shift+P", "Command palette: every menu action by name"],
    ],
  },
  {
    title: "Panes and sidebar",
    entries: [
      ["Ctrl+\\", "Split view on or off"],
      ["Ctrl+Shift+\\", "Swap left and right panes"],
      ["F6", "Switch pane"],
      ["Ctrl+Shift+L", "Show or hide the sidebar"],
      ["Ctrl+click on a file", "Open it in the other pane"],
    ],
  },
  {
    title: "Code blocks",
    entries: [
      ["Ctrl+Shift+C", "Toggle comment"],
      ["Ctrl+Alt+F", "Re-indent the block"],
      ["Ctrl+Shift+Up/Down", "Duplicate line"],
      ["Alt+Shift+Up/Down", "Move line"],
      ["Ctrl+X", "Without selection: cut the line"],
    ],
  },
  {
    title: "HTTP requests (```http blocks)",
    entries: [
      ["Ctrl+Alt+R", "Send the request at the cursor (also in the right-click menu)"],
      ["Send request button", "Above each request in an http block"],
      ["###", "Separates requests in one block"],
      ["@name = value", "File variable, used as {{name}}"],
      ["# @name login", "Names a request: {{login.response.body.$.token}}"],
      ["{{$guid}} {{$timestamp}}", "Also $randomInt, $datetime, $dotenv NAME (.env next to the file), $processEnv SNIB_*"],
      ["http-env.json", "Environments in the config folder, picked in the response panel"],
    ],
  },
  {
    title: "Terminal",
    entries: [
      ["Ctrl+Shift+T", "Show or hide the terminal"],
      ["Ctrl+Shift+5", "Split the terminal (up to 3)"],
      ["Selection", "Copied to PRIMARY; middle button pastes"],
      ["Drop files", "Pastes their paths"],
    ],
  },
  {
    title: "Zoom",
    entries: [
      ["Ctrl+wheel", "Zoom the area under the pointer: text, sidebar or terminal"],
      ["Ctrl+/-, Ctrl+0", "Zoom or reset the text (the terminal when it has focus)"],
    ],
  },
  {
    title: "Tips",
    entries: [
      ["Right-click", "Menu with styles, headings, lists, tables and alerts"],
      ["Ctrl+click on a link", "Open it (Ctrl+Shift+click: beside); http(s) links open in the integrated browser"],
      ["Right-click in the tree", "Terminal here, file manager, editor, copy path"],
      ["Paste or drop an image", "Saved in assets/ next to the document"],
      ["Database tab", "Only in builds with the db feature and a databases.toml: Ctrl+S saves the row, no autosave; Refresh reloads the list (e.g. after the VPN is up); right-click a row: save as local file, export HTML, PDF, Word or OpenDocument"],
      ["```mermaid", "Code block with a diagram preview"],
      ["$x^2$ and $$", "Inline and block formulas"],
    ],
  },
];

function build(): void {
  for (const section of SECTIONS) {
    const heading = document.createElement("h3");
    heading.textContent = section.title;
    const list = document.createElement("dl");
    list.className = "help-list";
    for (const [keys, label] of section.entries) {
      const term = document.createElement("dt");
      const kbd = document.createElement("kbd");
      kbd.textContent = keys;
      term.append(kbd);
      const desc = document.createElement("dd");
      desc.textContent = label;
      list.append(term, desc);
    }
    body.append(heading, list);
  }
  const note = document.createElement("p");
  note.className = "about-muted";
  note.textContent = "On macOS use Cmd instead of Ctrl (except for the zoom shortcuts, which use Ctrl).";
  body.append(note);
}

document.getElementById("help-close")!.addEventListener("click", () => dialog.close());

/** True while any dialog (about, history, PDF, palette, help...) is open. */
export function isDialogOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

export function showHelp(): void {
  // another modal is already open: do not stack on top of it
  if (isDialogOpen()) return;
  if (!body.hasChildNodes()) build();
  dialog.showModal();
}
