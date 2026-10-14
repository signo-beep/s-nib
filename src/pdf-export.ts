import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { collectFormulas } from "./math";
import { collectDiagrams } from "./mermaid";
import { showToast } from "./toast";

interface PdfSettings {
  paper: "a4" | "letter";
  marginMm: number;
  header: [string, string, string];
  footer: [string, string, string];
}

const dialog = document.getElementById("pdf-dialog") as HTMLDialogElement;
const form = document.getElementById("pdf-form") as HTMLFormElement;
const marginInput = document.getElementById("pdf-margin") as HTMLInputElement;
const headerInputs = [...document.querySelectorAll<HTMLInputElement>("[data-pdf-header]")];
const footerInputs = [...document.querySelectorAll<HTMLInputElement>("[data-pdf-footer]")];

function triple(value: unknown): [string, string, string] {
  const list = Array.isArray(value) ? value : [];
  const text = (index: number) => (typeof list[index] === "string" ? (list[index] as string) : "");
  return [text(0), text(1), text(2)];
}

/** Impostazioni globali dal file di configurazione dell'app (valori predefiniti se assente). */
async function loadSettings(): Promise<PdfSettings> {
  const raw = await invoke<Partial<PdfSettings>>("load_pdf_settings");
  return {
    paper: raw.paper === "letter" ? "letter" : "a4",
    marginMm: Number.isFinite(Number(raw.marginMm)) ? Number(raw.marginMm) : 22,
    header: triple(raw.header),
    footer: triple(raw.footer),
  };
}

async function saveSettings(settings: PdfSettings): Promise<void> {
  await invoke("save_pdf_settings", { settings });
}

function fillForm(settings: PdfSettings) {
  form.querySelectorAll<HTMLInputElement>('input[name="paper"]').forEach((radio) => {
    radio.checked = radio.value === settings.paper;
  });
  marginInput.value = String(settings.marginMm);
  headerInputs.forEach((input, index) => (input.value = settings.header[index] ?? ""));
  footerInputs.forEach((input, index) => (input.value = settings.footer[index] ?? ""));
}

function readForm(): PdfSettings {
  const paper = form.querySelector<HTMLInputElement>('input[name="paper"]:checked')?.value;
  const margin = Number(marginInput.value);
  return {
    paper: paper === "letter" ? "letter" : "a4",
    marginMm: Number.isFinite(margin) ? Math.min(60, Math.max(5, margin)) : 22,
    header: triple(headerInputs.map((input) => input.value)),
    footer: triple(footerInputs.map((input) => input.value)),
  };
}

type DialogMode = "defaults" | "export";

const MODE_TEXT: Record<DialogMode, { title: string; submit: string; hint: string }> = {
  defaults: {
    title: "Impostazioni PDF predefinite",
    submit: "Salva",
    hint: "Segnaposto: {title} titolo, {date} data, {page} pagina, {pages} totale pagine. Valgono per tutti i documenti.",
  },
  export: {
    title: "Esporta come PDF",
    submit: "Esporta",
    hint: "Segnaposto: {title} titolo, {date} data, {page} pagina, {pages} totale pagine. Le modifiche valgono solo per questo documento: le impostazioni predefinite non cambiano (File > Impostazioni PDF).",
  },
};

/**
 * Mostra il dialogo con i valori iniziali. In modalità "export" offre il ripristino
 * dei valori predefiniti. Restituisce null se annullato.
 */
async function askSettings(
  mode: DialogMode,
  initial: PdfSettings,
  defaults: PdfSettings,
): Promise<PdfSettings | null> {
  const text = MODE_TEXT[mode];
  document.getElementById("pdf-title")!.textContent = text.title;
  document.getElementById("pdf-submit")!.textContent = text.submit;
  document.getElementById("pdf-hint")!.textContent = text.hint;
  const reset = document.getElementById("pdf-reset") as HTMLButtonElement;
  reset.hidden = mode !== "export";
  fillForm(initial);

  return new Promise((resolve) => {
    const cancel = document.getElementById("pdf-cancel")!;
    const finish = (value: PdfSettings | null) => {
      form.removeEventListener("submit", onSubmit);
      cancel.removeEventListener("click", onCancel);
      reset.removeEventListener("click", onReset);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onSubmit = (event: Event) => {
      event.preventDefault();
      finish(readForm());
    };
    const onCancel = () => finish(null);
    const onReset = () => fillForm(defaults);
    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", onCancel);
    reset.addEventListener("click", onReset);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
  });
}

function parentDir(path: string): string | null {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : null;
}

function stem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]*$/, "");
}

/** Impostazioni predefinite globali: salvate su file, valgono per ogni documento. */
export async function editPdfSettings(): Promise<void> {
  const defaults = await loadSettings();
  const settings = await askSettings("defaults", defaults, defaults);
  if (!settings) return;
  await saveSettings(settings);
  showToast("Impostazioni PDF predefinite salvate");
}

/** Modifiche fatte in fase di export, per documento e solo per la sessione corrente. */
const documentOverrides = new Map<string, PdfSettings>();

export async function exportPdf(markdown: string, currentPath: string | null): Promise<void> {
  const defaults = await loadSettings();
  const key = currentPath ?? "\0untitled";
  const settings = await askSettings("export", documentOverrides.get(key) ?? defaults, defaults);
  if (!settings) return;
  if (JSON.stringify(settings) === JSON.stringify(defaults)) documentOverrides.delete(key);
  else documentOverrides.set(key, settings);

  const defaultPath = currentPath
    ? currentPath.replace(/\.[^.\\/]*$/, "") + ".pdf"
    : "senza-titolo.pdf";
  const path = await save({ filters: [{ name: "PDF", extensions: ["pdf"] }], defaultPath });
  if (!path) return;

  showToast("Generazione del PDF in corso...", "info", 0);
  const diagrams = await collectDiagrams(markdown);
  const formulas = await collectFormulas(markdown);
  await invoke("export_pdf", {
    path,
    markdown,
    options: {
      paper: settings.paper,
      marginMm: settings.marginMm,
      header: settings.header,
      footer: settings.footer,
      title: currentPath ? stem(currentPath) : "Senza titolo",
      date: new Date().toLocaleDateString("it-CH"),
      baseDir: currentPath ? parentDir(currentPath) : null,
      diagrams,
      formulas,
    },
  });
  showToast(`PDF salvato: ${path.split(/[\\/]/).pop() ?? path}`);
}
