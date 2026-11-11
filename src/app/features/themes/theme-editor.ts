import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { errorText } from '../../core/errors/app-error';
import { DARK, LIGHT } from '../../core/theme/builtin-themes';
import { tokenValueOk } from '../../core/theme/theme-logic';
import { ThemeEditRequest } from '../../core/theme/theme.models';
import { ThemeService } from '../../core/theme/theme.service';
import { TOKENS, TokenDef } from '../../core/theme/tokens';
import {
  ThemeDraft,
  draftOf,
  failingPairs,
  nameProblem,
  newUserId,
  swatchHex,
  themeOf,
  tokenContrast,
  withBrightness,
} from './theme-editor-logic';

/** The id of the scheme shown while editing; never stored. */
const PREVIEW_ID = 'user-preview';

interface Row {
  readonly def: TokenDef;
  readonly value: string;
  readonly swatch: string;
  readonly changed: boolean;
  readonly contrast: { readonly text: string; readonly ok: boolean; readonly title: string } | null;
}

interface Group {
  readonly name: string;
  readonly rows: readonly Row[];
}

/**
 * The scheme editor (design 001): every token of an own scheme with colour picker and text field. Each
 * change shows at once in the window behind (the preview of the `ThemeService`); „Speichern“ writes
 * `themes.json`, „Abbrechen“/Esc bring back what was on screen before. A panel at the right edge, so the
 * app stays visible while its colours change.
 */
@Component({
  selector: 'app-theme-editor',
  template: `
    <dialog
      #dialog
      aria-labelledby="theme-editor-title"
      (cancel)="$event.preventDefault(); cancel()"
      (close)="closed.emit()"
    >
      <header>
        <h2 id="theme-editor-title">Schema bearbeiten</h2>
        <button type="button" aria-label="Schließen" (click)="cancel()">×</button>
      </header>
      <div class="head">
        <label for="theme-name">Name</label>
        <input
          #nameInput
          id="theme-name"
          type="text"
          autocomplete="off"
          spellcheck="false"
          [value]="draft().name"
          [class.invalid]="nameError() !== null"
          [attr.aria-invalid]="nameError() !== null"
          [attr.aria-describedby]="nameError() ? 'theme-name-error' : null"
          (input)="setName(nameInput.value)"
        />
        <fieldset>
          <legend>Helligkeit</legend>
          <label
            ><input
              type="radio"
              name="theme-dark"
              [checked]="draft().dark"
              (change)="setDark(true)"
            />
            dunkel</label
          >
          <label
            ><input
              type="radio"
              name="theme-dark"
              [checked]="!draft().dark"
              (change)="setDark(false)"
            />
            hell</label
          >
        </fieldset>
        @if (nameError(); as problem) {
          <p id="theme-name-error" class="problem" role="alert">{{ problem }}</p>
        }
        <label for="theme-token-filter">Filter</label>
        <input
          #filterInput
          id="theme-token-filter"
          type="search"
          autocomplete="off"
          spellcheck="false"
          placeholder="Name eines Tokens"
          [value]="filter()"
          (input)="filter.set(filterInput.value)"
        />
      </div>
      @if (request().dropped.length > 0) {
        <p class="note" role="note">
          {{ request().dropped.length }} Einträge der Datei wurden verworfen:
          {{ droppedText() }}
        </p>
      }
      <div class="tokens">
        @for (group of groups(); track group.name) {
          <section [attr.aria-label]="group.name">
            <h3>{{ group.name }}</h3>
            @for (row of group.rows; track row.def.name) {
              <div class="row" [class.changed]="row.changed">
                <span class="label" [title]="row.def.name">{{ row.def.label }}</span>
                @if (row.def.kind === 'color') {
                  <input
                    #color
                    type="color"
                    [value]="row.swatch"
                    [attr.aria-label]="row.def.label + ', Farbe wählen'"
                    (input)="setToken(row.def.name, color.value)"
                  />
                } @else {
                  <span></span>
                }
                <input
                  #text
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  [value]="row.value"
                  [class.invalid]="invalid().has(row.def.name)"
                  [attr.aria-invalid]="invalid().has(row.def.name)"
                  [attr.aria-label]="row.def.label + ', Wert'"
                  (change)="typeToken(row.def.name, text)"
                />
                <button
                  type="button"
                  [disabled]="!row.changed"
                  [attr.aria-label]="row.def.label + ' zurücksetzen'"
                  title="Auf den Wert der Basis zurücksetzen"
                  (click)="resetToken(row.def.name)"
                >
                  ↺
                </button>
                @if (row.contrast; as c) {
                  <span class="contrast" [class.weak]="!c.ok" [title]="c.title">{{ c.text }}</span>
                } @else {
                  <span></span>
                }
              </div>
            }
          </section>
        }
        @if (groups().length === 0) {
          <p class="none" role="status">Kein Token passt zum Filter.</p>
        }
      </div>
      <p class="summary" role="status">
        @if (failing() === 0) {
          Alle Kontrastpaare erfüllen WCAG AA.
        } @else {
          ⚠ {{ failing() }} {{ failing() === 1 ? 'Kontrastpaar liegt' : 'Kontrastpaare liegen' }}
          unter WCAG AA.
        }
      </p>
      @if (error(); as message) {
        <p class="problem" role="alert">{{ message }}</p>
      }
      <footer>
        <button type="button" [disabled]="busy()" (click)="exportFile()">Exportieren …</button>
        @if (stored()) {
          <button type="button" class="danger" [disabled]="busy()" (click)="remove()">
            {{ confirmDelete() ? 'Wirklich löschen?' : 'Löschen' }}
          </button>
        }
        <span class="spacer"></span>
        <button type="button" (click)="cancel()">Abbrechen</button>
        <button
          type="button"
          class="primary"
          [disabled]="busy() || nameError() !== null"
          (click)="save()"
        >
          Speichern
        </button>
      </footer>
    </dialog>
  `,
  styleUrl: './theme-editor.css',
})
export class ThemeEditor implements OnInit {
  private readonly theme = inject(ThemeService);
  private readonly files = inject(FileDialogApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly request = input.required<ThemeEditRequest>();
  /** The dialog is gone; `true` = a scheme was saved or deleted. */
  readonly closed = output<void>();

  protected readonly draft = signal<ThemeDraft>({ id: null, name: '', dark: true, tokens: {} });
  protected readonly filter = signal('');
  /** Tokens whose text field holds something that is no value of their kind. */
  protected readonly invalid = signal<ReadonlySet<string>>(new Set());
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly confirmDelete = signal(false);

  protected readonly stored = computed(() => this.draft().id !== null);
  protected readonly nameError = computed(() => {
    const name = this.draft().name;
    const problem = nameProblem(name);
    if (problem) return problem;
    const own = this.draft().id;
    const taken = this.theme
      .themes()
      .some((t) => t.id !== own && t.name.toLowerCase() === name.trim().toLowerCase());
    return taken ? 'Diesen Namen gibt es schon.' : null;
  });
  protected readonly failing = computed(() => failingPairs(this.draft().tokens));
  protected readonly droppedText = computed(() => {
    const names = this.request().dropped;
    return names.length > 8 ? `${names.slice(0, 8).join(', ')} …` : names.join(', ');
  });

  protected readonly groups = computed<Group[]>(() => {
    const draft = this.draft();
    const base = (draft.dark ? DARK : LIGHT).tokens;
    const words = this.filter().toLowerCase().split(/\s+/).filter(Boolean);
    const out: Group[] = [];
    for (const def of TOKENS) {
      const hay = `${def.label} ${def.name} ${def.group}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const value = draft.tokens[def.name] ?? '';
      const row: Row = {
        def,
        value,
        swatch: def.kind === 'color' ? swatchHex(def.name, draft.tokens) : '#000000',
        changed: base[def.name] !== undefined && base[def.name] !== value,
        contrast: def.kind === 'color' ? contrastBadge(def.name, draft.tokens) : null,
      };
      const last = out[out.length - 1];
      if (last?.name === def.group) (last.rows as Row[]).push(row);
      else out.push({ name: def.group, rows: [row] });
    }
    return out;
  });

  constructor() {
    const preview = this.theme.preview;
    inject(DestroyRef).onDestroy(() => preview.set(null));
  }

  ngOnInit(): void {
    const theme = this.request().theme;
    this.draft.set(draftOf(theme, LIGHT, DARK, theme.id === '' ? null : theme.id));
    this.show();
    this.dialog().nativeElement.showModal();
  }

  protected setName(name: string): void {
    this.draft.update((d) => ({ ...d, name }));
  }

  protected setDark(dark: boolean): void {
    this.draft.update((d) => withBrightness(d, dark, LIGHT, DARK));
    this.show();
  }

  /** A value from the colour picker: always a plain colour. */
  protected setToken(name: string, value: string): void {
    this.draft.update((d) => ({ ...d, tokens: { ...d.tokens, [name]: value } }));
    this.clearInvalid(name);
    this.show();
  }

  /** A value typed by hand: taken over only when it is a value of the token's kind. */
  protected typeToken(name: string, field: HTMLInputElement): void {
    const value = field.value.trim();
    if (!tokenValueOk(name, value)) {
      this.invalid.update((s) => new Set(s).add(name));
      return;
    }
    this.setToken(name, value);
  }

  protected resetToken(name: string): void {
    const base = (this.draft().dark ? DARK : LIGHT).tokens[name];
    if (base !== undefined) this.setToken(name, base);
  }

  protected async save(): Promise<void> {
    if (this.busy() || this.nameError()) return;
    const draft = this.draft();
    const id = draft.id ?? newUserId(draft.name, new Set(this.theme.themes().map((t) => t.id)));
    const theme = themeOf(draft, id, LIGHT, DARK);
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.theme.saveUserTheme(theme);
      this.theme.preview.set(null);
      this.theme.select(id);
      this.dialog().nativeElement.close();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Asks once more on the button itself, then deletes. */
  protected async remove(): Promise<void> {
    const id = this.draft().id;
    if (id === null || this.busy()) return;
    if (!this.confirmDelete()) {
      this.confirmDelete.set(true);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.theme.deleteUserTheme(id);
      this.theme.preview.set(null);
      this.dialog().nativeElement.close();
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async exportFile(): Promise<void> {
    if (this.busy()) return;
    const draft = this.draft();
    const name = draft.name.trim() || 'Schema';
    this.busy.set(true);
    this.error.set(null);
    try {
      const path = await this.files.saveFile('Farbschema exportieren', `${name}.theme.json`, [
        { name: 'Farbschema', extensions: ['json'] },
      ]);
      if (path !== null) {
        const id = draft.id ?? newUserId(name, new Set());
        await this.theme.exportTheme(path, themeOf({ ...draft, name }, id, LIGHT, DARK));
      }
    } catch (e) {
      this.error.set(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Esc / Abbrechen / ×: what was on screen before comes back. */
  protected cancel(): void {
    this.theme.preview.set(null);
    this.dialog().nativeElement.close();
  }

  private clearInvalid(name: string): void {
    if (!this.invalid().has(name)) return;
    this.invalid.update((s) => {
      const next = new Set(s);
      next.delete(name);
      return next;
    });
  }

  /** Puts the draft on screen. */
  private show(): void {
    this.theme.preview.set(themeOf(this.draft(), PREVIEW_ID, LIGHT, DARK));
  }
}

function contrastBadge(name: string, tokens: Readonly<Record<string, string>>): Row['contrast'] {
  const c = tokenContrast(name, tokens);
  if (!c) return null;
  const ratio = c.ratio.toFixed(1);
  return {
    text: c.ok ? ratio : `⚠ ${ratio}`,
    ok: c.ok,
    title: `Kontrast ${ratio}:1 gegen ${c.against} (Soll ${c.min}:1)`,
  };
}
