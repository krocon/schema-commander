import { SshHost, SshTarget, tlsUnchecked } from '../../core/connections/connection.models';
import { shownHostKey } from '../../core/connections/connections.store';
import { toAppError } from '../../core/errors/app-error';
import { stageOf } from './connection-logic';
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
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { CONNECTION_DIALOG_TEXTS } from './connection-dialog-texts';
import {
  kindName,
  portPlaceholder,
  portText,
  profileProblems,
  suggestedName,
  suggestedTls,
  withKind,
} from './connection-logic';

const COLORS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * The dialog of a connection (prompt 003): its settings, testing and saving. The password field is
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
            {{ draft().id ? t.titleEdit : t.titleNew }}
          </h2>
          <button type="button" [attr.aria-label]="common.close" (click)="cancel()">×</button>
        </header>
        @if (!draft().id) {
          <div class="from-url">
            <input
              #url
              type="text"
              autocomplete="off"
              spellcheck="false"
              [attr.aria-label]="t.urlLabel"
              [placeholder]="t.urlPlaceholder"
              (paste)="pasteUrl($event)"
              (keydown.enter)="$event.preventDefault(); fromUrl(url.value)"
            />
            <button type="button" (click)="fromUrl(url.value)">{{ t.apply }}</button>
          </div>
          @if (urlProblem(); as p) {
            <p class="message problem" role="alert">{{ p }}</p>
          }
        }
        <div class="fields">
          <label for="conn-kind">{{ t.database }}</label>
          <select id="conn-kind" #kind (change)="setKind(kind.value)">
            @for (k of kinds; track k.kind) {
              <option [value]="k.kind" [selected]="k.kind === draft().kind">
                {{ kindName(k.kind) }}
              </option>
            }
          </select>

          <label for="conn-name">{{ common.name }}</label>
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
            <label for="conn-database">{{ t.file }}</label>
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
              <button type="button" (click)="chooseFile()">{{ t.choose }}</button>
            </span>
          } @else {
            <label for="conn-host">{{ t.host }}</label>
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
              <label for="conn-port" class="inline">{{ t.port }}</label>
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

            <label for="conn-database">{{ t.database }}</label>
            <input
              #database
              id="conn-database"
              type="text"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              [placeholder]="t.serverDefault"
              [value]="draft().database"
              (input)="patch({ database: database.value })"
            />

            <label for="conn-user">{{ t.user }}</label>
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

            <label for="conn-password">{{ t.password }}</label>
            <span class="row">
              <input
                #password
                id="conn-password"
                type="password"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                [placeholder]="draft().id ? t.unchanged : ''"
              />
              <label class="check"
                ><input
                  #remember
                  type="checkbox"
                  [checked]="draft().savePassword"
                  (change)="patch({ savePassword: remember.checked })"
                />
                {{ t.rememberInKeychain }}</label
              >
            </span>

            <label for="conn-tls">{{ t.encryption }}</label>
            <select id="conn-tls" #tls (change)="setTls(tls.value)">
              <option value="verify" [selected]="draft().tls === 'verify'">
                {{ t.tlsVerify }}
              </option>
              <option value="verify-ca" [selected]="draft().tls === 'verify-ca'">
                {{ t.tlsVerifyCa }}
              </option>
              <option value="require" [selected]="draft().tls === 'require'">
                {{ t.tlsRequire }}
              </option>
              <option value="prefer" [selected]="draft().tls === 'prefer'">
                {{ t.tlsPrefer }}
              </option>
              <option value="off" [selected]="draft().tls === 'off'">
                {{ t.tlsOff }}
              </option>
            </select>
            @if (draft().tls === 'verify-ca' || draft().tls === 'verify') {
              <label for="conn-ca">{{ t.caFile }}</label>
              <span class="row">
                <input
                  #ca
                  id="conn-ca"
                  type="text"
                  spellcheck="false"
                  [placeholder]="t.caPlaceholder"
                  [title]="t.caHint"
                  [value]="draft().caFile"
                  (input)="patch({ caFile: ca.value })"
                />
                <button type="button" (click)="choosePem('caFile')">{{ t.choose }}</button>
              </span>
            }
            @if (draft().tls !== 'off' && draft().kind !== 'sqlserver') {
              <label for="conn-cert">{{ t.clientCert }}</label>
              <span class="row">
                <input
                  #cert
                  id="conn-cert"
                  type="text"
                  spellcheck="false"
                  [placeholder]="t.clientCertNone"
                  [value]="draft().clientCert"
                  (input)="patch({ clientCert: cert.value })"
                />
                <button type="button" (click)="choosePem('clientCert')">{{ t.choose }}</button>
              </span>
              <label for="conn-key">{{ t.clientKey }}</label>
              <span class="row">
                <input
                  #key
                  id="conn-key"
                  type="text"
                  spellcheck="false"
                  [placeholder]="t.clientKeyNone"
                  [value]="draft().clientKey"
                  [class.invalid]="shown('clientKey')"
                  (input)="patch({ clientKey: key.value })"
                />
                <button type="button" (click)="choosePem('clientKey')">{{ t.choose }}</button>
              </span>
            }

            <span id="conn-ssh-label">{{ t.sshTunnel }}</span>
            <label class="check"
              ><input
                #viaSsh
                type="checkbox"
                aria-labelledby="conn-ssh-label"
                [checked]="!!draft().ssh"
                (change)="setSsh(viaSsh.checked)"
              />
              {{ t.viaJumpHost }}</label
            >
            @if (draft().ssh; as ssh) {
              @if (sshHosts().length > 0) {
                <label for="conn-ssh-alias">{{ t.fromSshConfig }}</label>
                <select id="conn-ssh-alias" #alias (change)="useSshHost(alias.value)">
                  <option value="">{{ t.sshTakeNothing }}</option>
                  @for (h of sshHosts(); track h.alias) {
                    <option [value]="h.alias" [disabled]="h.proxy">
                      {{ h.proxy ? t.sshProxyJump(h.alias) : h.alias }}
                    </option>
                  }
                </select>
              }
              <label for="conn-ssh-host">{{ t.sshHost }}</label>
              <span class="row">
                <input
                  #sshHost
                  id="conn-ssh-host"
                  type="text"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  [value]="ssh.host"
                  [class.invalid]="shown('sshHost')"
                  (input)="patchSsh({ host: sshHost.value })"
                />
                <label for="conn-ssh-port" class="inline">{{ t.port }}</label>
                <input
                  #sshPort
                  id="conn-ssh-port"
                  class="port"
                  type="text"
                  inputmode="numeric"
                  placeholder="22"
                  [value]="ssh.port || ''"
                  [class.invalid]="shown('sshPort')"
                  (input)="setSshPort(sshPort.value)"
                />
              </span>
              <label for="conn-ssh-user">{{ t.sshUser }}</label>
              <input
                #sshUser
                id="conn-ssh-user"
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                [value]="ssh.user"
                [class.invalid]="shown('sshUser')"
                (input)="patchSsh({ user: sshUser.value })"
              />
              <label for="conn-ssh-auth">{{ t.sshAuth }}</label>
              <select id="conn-ssh-auth" #sshAuth (change)="setSshAuth(sshAuth.value)">
                <option value="agent" [selected]="ssh.auth === 'agent'">{{ t.sshAgent }}</option>
                <option value="key" [selected]="ssh.auth === 'key'">{{ t.keyFile }}</option>
                <option value="password" [selected]="ssh.auth === 'password'">
                  {{ t.password }}
                </option>
              </select>
              @if (ssh.auth === 'key') {
                <label for="conn-ssh-key">{{ t.keyFile }}</label>
                <span class="row">
                  <input
                    #sshKey
                    id="conn-ssh-key"
                    type="text"
                    spellcheck="false"
                    [placeholder]="t.sshKeyPlaceholder"
                    [value]="ssh.keyFile"
                    (input)="patchSsh({ keyFile: sshKey.value })"
                  />
                  <button type="button" (click)="chooseSshKey()">{{ t.choose }}</button>
                </span>
              }
              @if (ssh.auth !== 'agent') {
                <label for="conn-ssh-secret">{{
                  ssh.auth === 'key' ? t.passphrase : t.sshPassword
                }}</label>
                <input
                  #sshSecret
                  id="conn-ssh-secret"
                  type="password"
                  autocomplete="off"
                  [placeholder]="t.sshSecretPlaceholder"
                />
              }
            }
          }

          <label for="conn-folder">{{ t.folder }}</label>
          <input
            #folder
            id="conn-folder"
            type="text"
            autocomplete="off"
            spellcheck="false"
            [placeholder]="t.folderNone"
            [value]="draft().folder"
            (input)="patch({ folder: folder.value })"
          />

          <label for="conn-protection">{{ t.protection }}</label>
          <select id="conn-protection" #protection (change)="setProtection(protection.value)">
            <option value="free" [selected]="draft().protection === 'free'">
              {{ t.protectionFree }}
            </option>
            <option value="ask" [selected]="draft().protection === 'ask'">
              {{ t.protectionAsk }}
            </option>
            <option value="readonly" [selected]="draft().protection === 'readonly'">
              {{ t.protectionReadonly }}
            </option>
          </select>

          <label for="conn-label">{{ t.mark }}</label>
          <input
            #mark
            id="conn-label"
            type="text"
            maxlength="12"
            autocomplete="off"
            spellcheck="false"
            [placeholder]="t.markPlaceholder"
            [value]="draft().label"
            (input)="patch({ label: mark.value })"
          />

          <span id="conn-color-label">{{ t.color }}</span>
          <span class="colors" role="radiogroup" aria-labelledby="conn-color-label">
            @for (c of colors; track c) {
              <label [class]="'swatch conn-' + c" [class.on]="draft().color === c">
                <input
                  type="radio"
                  name="conn-color"
                  [checked]="draft().color === c"
                  [attr.aria-label]="t.colorN(c)"
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
            {{ t.warnPlain }}
          </p>
        }
        @if (uncheckedTls()) {
          <p class="message warn" role="note">
            {{ t.warnUnchecked }}
          </p>
        }
        @if (unknownKey(); as k) {
          <p class="message warn" role="alert">
            {{ t.unknownKey }}
            <code>{{ k.keyType }} {{ k.fingerprint }}</code>
            <button type="button" (click)="test(k.fingerprint)">{{ t.trustAndRetest }}</button>
          </p>
        }
        @if (result(); as r) {
          <p class="message" [class.problem]="!r.ok" [class.ok]="r.ok" role="status">
            {{ r.text }}
          </p>
        }
        <footer>
          <button type="button" [disabled]="busy()" (click)="test()">
            {{ busy() === 'test' ? t.testing : t.test }}
          </button>
          @if (draft().id) {
            <button type="button" class="danger" [disabled]="!!busy()" (click)="remove()">
              {{ confirmDelete() ? t.reallyDelete : common.delete }}
            </button>
          }
          <span class="spacer"></span>
          <button type="button" (click)="cancel()">{{ common.cancel }}</button>
          <button type="button" [disabled]="!!busy()" (click)="save(false)">
            {{ common.save }}
          </button>
          <button type="submit" class="primary" [disabled]="!!busy()">
            {{ t.saveAndConnect }}
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

  protected readonly t = CONNECTION_DIALOG_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly kindName = kindName;
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
  private readonly sshSecretField = viewChild<ElementRef<HTMLInputElement>>('sshSecret');
  /** The hosts of `~/.ssh/config`, read when the tunnel is switched on. */
  protected readonly sshHosts = signal<readonly SshHost[]>([]);
  /** The key an SSH server showed in a test and nobody confirmed yet. */
  protected readonly unknownKey = signal<{ keyType: string; fingerprint: string } | null>(null);
  protected readonly urlProblem = signal<string | null>(null);
  protected readonly uncheckedTls = computed(
    () => this.draft().kind !== 'sqlite' && tlsUnchecked(this.draft().tls),
  );

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
    if (this.profile().ssh) this.loadSshHosts();
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

  protected setProtection(value: string): void {
    if (value === 'free' || value === 'ask' || value === 'readonly') {
      this.patch({ protection: value });
    }
  }

  protected setTls(mode: string): void {
    this.tlsChosen = true;
    this.patch({ tls: mode as TlsMode });
  }

  /** A pasted text that is a connection URL fills the dialog at once. */
  protected pasteUrl(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.trim()) void this.fromUrl(text);
  }

  /** Fills the dialog from a URL; its password goes into the password field, nowhere else. */
  protected async fromUrl(text: string): Promise<void> {
    if (!text.trim()) return;
    try {
      const found = await this.store.parseUrl(text);
      this.urlProblem.set(null);
      this.tlsChosen = true;
      this.draft.set({ ...found.profile, name: this.draft().name || found.profile.name });
      this.result.set(null);
      if (found.profile.ssh) this.loadSshHosts();
      // the field exists once the form shows the new kind
      setTimeout(() => {
        const field = this.password()?.nativeElement;
        if (field) field.value = found.password ?? '';
      });
    } catch (e) {
      this.urlProblem.set(describeError(e));
    }
  }

  protected setSsh(on: boolean): void {
    this.patch({
      ssh: on ? { host: '', port: 0, user: '', auth: 'agent', keyFile: '' } : null,
      // through a tunnel the host name of the certificate cannot be checked
      ...(on && this.draft().tls === 'verify' ? { tls: 'verify-ca' as const } : {}),
    });
    if (on) this.loadSshHosts();
  }

  private loadSshHosts(): void {
    if (this.sshHosts().length > 0) return;
    void this.store.sshHosts().then(
      (hosts) => this.sshHosts.set(hosts),
      () => undefined,
    );
  }

  protected patchSsh(change: Partial<SshTarget>): void {
    const ssh = this.draft().ssh;
    if (ssh) this.patch({ ssh: { ...ssh, ...change } });
  }

  protected setSshPort(text: string): void {
    const t = text.trim();
    this.patchSsh({ port: t === '' ? 0 : /^\d{1,5}$/.test(t) ? Number(t) : -1 });
  }

  protected setSshAuth(value: string): void {
    if (value === 'agent' || value === 'key' || value === 'password') {
      this.patchSsh({ auth: value });
    }
  }

  /** Fills the jump host from an entry of `~/.ssh/config`. */
  protected useSshHost(alias: string): void {
    const host = this.sshHosts().find((h) => h.alias === alias);
    if (!host || host.proxy) return;
    this.patchSsh({
      host: host.hostName,
      port: host.port ?? 0,
      user: host.user ?? this.draft().ssh?.user ?? '',
      ...(host.identityFiles.length > 0
        ? { auth: 'key' as const, keyFile: host.identityFiles[0] }
        : {}),
    });
  }

  protected async choosePem(field: 'caFile' | 'clientCert' | 'clientKey'): Promise<void> {
    const path = await this.files.openFile(this.t.chooseFileTitle, [
      { name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key'] },
      { name: this.t.allFiles, extensions: ['*'] },
    ]);
    if (path !== null) this.patch({ [field]: path });
  }

  protected async chooseSshKey(): Promise<void> {
    const path = await this.files.openFile(this.t.chooseKeyFileTitle, [
      { name: this.t.allFiles, extensions: ['*'] },
    ]);
    if (path !== null) this.patchSsh({ keyFile: path });
  }

  protected async chooseFile(): Promise<void> {
    const path = await this.files.openFile(this.t.chooseSqliteTitle, [
      { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
      { name: this.t.allFiles, extensions: ['*'] },
    ]);
    if (path !== null) this.patch({ database: path });
  }

  /** Tries the connection; the error says which stage failed. `trust`: a host key the user confirmed. */
  protected async test(trust: string | null = null): Promise<void> {
    this.tried.set(true);
    if (Object.keys(this.problems()).length > 0 || this.busy()) return;
    this.busy.set('test');
    this.result.set(null);
    this.unknownKey.set(null);
    const secret = this.sshSecretField()?.nativeElement.value || null;
    try {
      const version = await this.store.test(this.withName(), this.typedPassword(), {
        secret,
        trustFingerprint: trust,
      });
      this.result.set({ ok: true, text: this.t.connectionWorks(version) });
    } catch (e) {
      const error = toAppError(e);
      if (error.code === 'host_key_unknown') this.unknownKey.set(shownHostKey(error.message));
      else this.result.set({ ok: false, text: `${stageOf(error.code)}${describeError(error)}` });
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
