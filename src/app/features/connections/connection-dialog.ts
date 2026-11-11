import {
  Component,
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
import {
  DB_KINDS,
  DbKind,
  Profile,
  TlsMode,
  usesPassword,
} from '../../core/connections/connection.models';
import { ConnectionsStore } from '../../core/connections/connections.store';
import { describeError } from '../../core/errors/app-error';
import {
  portPlaceholder,
  portText,
  profileProblems,
  suggestedName,
  suggestedTls,
  withKind,
} from './connection-logic';

const COLORS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * The dialog of a connection (prompt 003): its settings, „Testen“ and „Speichern“. The password field is
 * write-only: a stored password is never shown or sent back; an empty field leaves it as it is.
 */
@Component({
  selector: 'app-connection-dialog',
  template: `
    <dialog
      #dialog
      aria-labelledby="connection-title"
      (cancel)="$event.preventDefault(); cancel()"
      (close)="closed.emit()"
    >
      <form (submit)="$event.preventDefault(); save(true)">
        <header>
          <h2 id="connection-title">
            {{ draft().id ? 'Verbindung bearbeiten' : 'Neue Verbindung' }}
          </h2>
          <button type="button" aria-label="Schließen" (click)="cancel()">×</button>
        </header>
        <div class="fields">
          <label for="conn-kind">Datenbank</label>
          <select id="conn-kind" #kind (change)="setKind(kind.value)">
            @for (k of kinds; track k.kind) {
              <option [value]="k.kind" [selected]="k.kind === draft().kind">{{ k.label }}</option>
            }
          </select>

          <label for="conn-name">Name</label>
          <input
            #name
            id="conn-name"
            type="text"
            autocomplete="off"
            spellcheck="false"
            [placeholder]="namePlaceholder()"
            [value]="draft().name"
            [class.invalid]="shown('name')"
            [attr.aria-invalid]="!!shown('name')"
            (input)="patch({ name: name.value })"
          />

          @if (draft().kind === 'sqlite') {
            <label for="conn-database">Datei</label>
            <span class="row">
              <input
                #file
                id="conn-database"
                type="text"
                autocomplete="off"
                spellcheck="false"
                [value]="draft().database"
                [class.invalid]="shown('database')"
                [attr.aria-invalid]="!!shown('database')"
                (input)="patch({ database: file.value })"
              />
              <button type="button" (click)="chooseFile()">Wählen …</button>
            </span>
          } @else {
            <label for="conn-host">Host</label>
            <span class="row">
              <input
                #host
                id="conn-host"
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                [value]="draft().host"
                [class.invalid]="shown('host')"
                [attr.aria-invalid]="!!shown('host')"
                (input)="setHost(host.value)"
              />
              <label for="conn-port" class="inline">Port</label>
              <input
                #port
                id="conn-port"
                class="port"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                [placeholder]="portPlaceholder()"
                [value]="portText()"
                [class.invalid]="shown('port')"
                [attr.aria-invalid]="!!shown('port')"
                (input)="setPort(port.value)"
              />
            </span>

            <label for="conn-database">Datenbank</label>
            <input
              #database
              id="conn-database"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="(Vorgabe des Servers)"
              [value]="draft().database"
              (input)="patch({ database: database.value })"
            />

            <label for="conn-user">Benutzer</label>
            <input
              #user
              id="conn-user"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              [value]="draft().user"
              [class.invalid]="shown('user')"
              [attr.aria-invalid]="!!shown('user')"
              (input)="patch({ user: user.value })"
            />

            <label for="conn-password">Passwort</label>
            <span class="row">
              <input
                #password
                id="conn-password"
                type="password"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                [placeholder]="draft().id ? '(unverändert)' : ''"
              />
              <label class="check"
                ><input
                  #remember
                  type="checkbox"
                  [checked]="draft().savePassword"
                  (change)="patch({ savePassword: remember.checked })"
                />
                im Schlüsselbund merken</label
              >
            </span>

            <label for="conn-tls">Verschlüsselung</label>
            <select id="conn-tls" #tls (change)="setTls(tls.value)">
              <option value="verify" [selected]="draft().tls === 'verify'">
                TLS, Zertifikat und Hostname werden geprüft
              </option>
              <option value="off" [selected]="draft().tls === 'off'">
                keine (nur für Server auf diesem Rechner)
              </option>
            </select>
          }

          <label for="conn-folder">Ordner</label>
          <input
            #folder
            id="conn-folder"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="(keiner)"
            [value]="draft().folder"
            (input)="patch({ folder: folder.value })"
          />

          <span id="conn-color-label">Farbe</span>
          <span class="colors" role="radiogroup" aria-labelledby="conn-color-label">
            @for (c of colors; track c) {
              <label [class]="'swatch conn-' + c" [class.on]="draft().color === c">
                <input
                  type="radio"
                  name="conn-color"
                  [checked]="draft().color === c"
                  [attr.aria-label]="'Farbe ' + c"
                  (change)="patch({ color: c })"
                />
              </label>
            }
          </span>
        </div>
        @if (firstProblem(); as problem) {
          <p class="message problem" role="alert">{{ problem }}</p>
        }
        @if (tlsWarning()) {
          <p class="message warn" role="note">
            Ohne Verschlüsselung gehen Passwort und Daten lesbar über das Netz.
          </p>
        }
        @if (result(); as r) {
          <p class="message" [class.problem]="!r.ok" [class.ok]="r.ok" role="status">
            {{ r.text }}
          </p>
        }
        <footer>
          <button type="button" [disabled]="busy()" (click)="test()">
            {{ busy() === 'test' ? 'Teste …' : 'Testen' }}
          </button>
          @if (draft().id) {
            <button type="button" class="danger" [disabled]="!!busy()" (click)="remove()">
              {{ confirmDelete() ? 'Wirklich löschen?' : 'Löschen' }}
            </button>
          }
          <span class="spacer"></span>
          <button type="button" (click)="cancel()">Abbrechen</button>
          <button type="button" [disabled]="!!busy()" (click)="save(false)">Speichern</button>
          <button type="submit" class="primary" [disabled]="!!busy()">
            Speichern und verbinden
          </button>
        </footer>
      </form>
    </dialog>
  `,
  styleUrl: './connection-dialog.css',
})
export class ConnectionDialog implements OnInit {
  private readonly store = inject(ConnectionsStore);
  private readonly files = inject(FileDialogApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly password = viewChild<ElementRef<HTMLInputElement>>('password');

  /** The profile to edit; `id === ''` for a new one. */
  readonly profile = input.required<Profile>();
  readonly closed = output<void>();

  protected readonly kinds = DB_KINDS;
  protected readonly colors = COLORS;
  protected readonly draft = signal<Profile>(null as unknown as Profile);
  /** Problems are shown once the user tried to store or test. */
  protected readonly tried = signal(false);
  protected readonly busy = signal<'test' | 'save' | null>(null);
  protected readonly result = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly confirmDelete = signal(false);
  /** The user chose the TLS mode: it no longer follows the host. */
  private tlsChosen = false;

  protected readonly problems = computed(() => profileProblems(this.withName()));
  protected readonly firstProblem = computed(() =>
    this.tried() ? (Object.values(this.problems())[0] ?? null) : null,
  );
  protected readonly namePlaceholder = computed(() => suggestedName(this.draft()));
  protected readonly portPlaceholder = computed(() => portPlaceholder(this.draft().kind));
  protected readonly portText = computed(() => portText(this.draft()));
  protected readonly tlsWarning = computed(() => {
    const d = this.draft();
    return d.kind !== 'sqlite' && d.tls === 'off' && suggestedTls(d.host) === 'verify';
  });

  ngOnInit(): void {
    this.draft.set(this.profile());
    this.tlsChosen = this.profile().id !== '';
    this.dialog().nativeElement.showModal();
  }

  protected shown(field: keyof ReturnType<typeof profileProblems>): string | null {
    return this.tried() ? (this.problems()[field] ?? null) : null;
  }

  protected patch(change: Partial<Profile>): void {
    this.draft.update((d) => ({ ...d, ...change }));
    this.result.set(null);
  }

  protected setKind(kind: string): void {
    this.draft.update((d) => withKind(d, kind as DbKind));
    this.result.set(null);
  }

  protected setHost(host: string): void {
    this.patch(this.tlsChosen ? { host } : { host, tls: suggestedTls(host) });
  }

  protected setPort(text: string): void {
    const t = text.trim();
    this.patch({ port: t === '' ? 0 : /^\d{1,5}$/.test(t) ? Number(t) : -1 });
  }

  protected setTls(mode: string): void {
    this.tlsChosen = true;
    this.patch({ tls: mode as TlsMode });
  }

  protected async chooseFile(): Promise<void> {
    const path = await this.files.openFile('SQLite-Datei wählen', [
      { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
      { name: 'Alle Dateien', extensions: ['*'] },
    ]);
    if (path !== null) this.patch({ database: path });
  }

  protected async test(): Promise<void> {
    this.tried.set(true);
    if (Object.keys(this.problems()).length > 0 || this.busy()) return;
    this.busy.set('test');
    this.result.set(null);
    try {
      const version = await this.store.test(this.withName(), this.typedPassword());
      this.result.set({ ok: true, text: `Verbindung steht: ${version}` });
    } catch (e) {
      this.result.set({ ok: false, text: describeError(e) });
    } finally {
      this.busy.set(null);
    }
  }

  protected async save(connect: boolean): Promise<void> {
    this.tried.set(true);
    if (Object.keys(this.problems()).length > 0 || this.busy()) return;
    this.busy.set('save');
    this.result.set(null);
    try {
      const stored = await this.store.save(this.withName(), this.typedPassword());
      this.clearPassword();
      this.dialog().nativeElement.close();
      if (connect) {
        this.store.activate(stored.id);
        void this.store.connect(stored.id);
      }
    } catch (e) {
      this.result.set({ ok: false, text: describeError(e) });
    } finally {
      this.busy.set(null);
    }
  }

  /** Asks once more on the button itself, then deletes. */
  protected async remove(): Promise<void> {
    if (this.busy()) return;
    if (!this.confirmDelete()) {
      this.confirmDelete.set(true);
      return;
    }
    this.busy.set('save');
    try {
      await this.store.remove(this.draft().id);
      this.clearPassword();
      this.dialog().nativeElement.close();
    } catch (e) {
      this.result.set({ ok: false, text: describeError(e) });
    } finally {
      this.busy.set(null);
    }
  }

  protected cancel(): void {
    this.clearPassword();
    this.dialog().nativeElement.close();
  }

  /** The draft with the suggested name when the field is empty. */
  private withName(): Profile {
    const d = this.draft();
    return d.name.trim() ? d : { ...d, name: suggestedName(d) };
  }

  private typedPassword(): string | null {
    if (!usesPassword(this.draft())) return null;
    const text = this.password()?.nativeElement.value ?? '';
    return text === '' ? null : text;
  }

  /** Nothing of the password stays in the page. */
  private clearPassword(): void {
    const field = this.password()?.nativeElement;
    if (field) field.value = '';
  }
}
