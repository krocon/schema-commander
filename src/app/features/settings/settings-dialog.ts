import {
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ActionService } from '../../core/actions/action.service';
import { FileDialogApi } from '../../core/backend/file-dialog-api';
import { describeError } from '../../core/errors/app-error';
import { COMMON_TEXTS } from '../../core/i18n/common-texts';
import { SessionApi } from '../../core/session/session-api';
import { DEFAULT_SETTINGS, Settings } from '../../core/settings/settings.models';
import { SettingsService } from '../../core/settings/settings.service';
import { ConfirmService } from '../../shared/confirm';
import { FormatService } from '../format/format.service';
import { styleOf } from '../format/format-logic';
import {
  GROUPS,
  GroupId,
  SETTING_DEFS,
  SettingDef,
  SettingKey,
  choiceLabel,
  exportSettings,
  importSettings,
  isDefault,
  resetOf,
  searchSettings,
} from './settings-logic';
import { SETTINGS_TEXTS } from './settings-texts';

const JSON_FILES = [{ name: 'JSON', extensions: ['json'] }];

/**
 * The settings (prompt 017): groups on the left (a vertical tab list after the APG pattern), a search over
 * all of them, every change acts at once – there is nothing to save or to cancel. Each value can go back to
 * its default, and all of them together. The settings can be written to a file and read from one.
 */
@Component({
  selector: 'app-settings-dialog',
  template: `
    <dialog #dialog aria-labelledby="settings-title" (cancel)="$event.preventDefault(); close()">
      <header>
        <h2 id="settings-title">{{ t.title }}</h2>
        <input
          #search
          type="search"
          class="search"
          autocomplete="off"
          spellcheck="false"
          [attr.aria-label]="t.search"
          [placeholder]="t.search"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
        <button type="button" class="x" [attr.aria-label]="common.close" (click)="close()">
          ×
        </button>
      </header>
      <div class="body">
        <div
          class="groups"
          role="tablist"
          aria-orientation="vertical"
          [attr.aria-label]="t.groupsLabel"
        >
          @for (g of groups; track g) {
            <button
              type="button"
              role="tab"
              [id]="'settings-tab-' + g"
              aria-controls="settings-panel"
              [attr.aria-selected]="!searching() && group() === g"
              [tabindex]="group() === g ? 0 : -1"
              (click)="show(g)"
              (keydown)="onGroupKey($event)"
            >
              {{ t.groups[g] }}
            </button>
          }
        </div>
        <div
          id="settings-panel"
          class="panel"
          role="tabpanel"
          tabindex="-1"
          [attr.aria-labelledby]="searching() ? null : 'settings-tab-' + group()"
          [attr.aria-label]="searching() ? t.found(shown().length) : null"
        >
          @if (searching()) {
            <p class="found" role="status">
              {{ shown().length === 0 ? t.nothingFound : t.found(shown().length) }}
            </p>
          }
          @if (!searching() && group() === 'general') {
            <div class="row">
              <span class="label">{{ t.colorScheme }}</span>
              <button type="button" class="control" (click)="run('COLOR_SCHEME')">
                {{ t.chooseScheme }}
              </button>
            </div>
            <div class="row">
              <span class="label">{{ t.shortcuts }}</span>
              <button type="button" class="control" (click)="run('OPEN_SHORTCUTS')">
                {{ t.editShortcuts }}
              </button>
            </div>
          }
          @for (def of shown(); track def.key) {
            @let id = 'setting-' + def.key;
            @let value = settings.settings()[def.key];
            <div class="row" [class.changed]="!isDefault(def.key)">
              <label class="label" [for]="id">
                @if (searching()) {
                  <small class="where">{{ t.groups[def.group] }}</small>
                }
                {{ t.labels[def.key] }}
              </label>
              @switch (def.kind) {
                @case ('bool') {
                  <input
                    type="checkbox"
                    class="control"
                    [id]="id"
                    [checked]="value === true"
                    [attr.aria-describedby]="id + '-help'"
                    (change)="set(def, $any($event.target).checked)"
                  />
                }
                @case ('number') {
                  <input
                    type="number"
                    class="control"
                    [id]="id"
                    [min]="def.min"
                    [max]="def.max"
                    [step]="def.step"
                    [value]="value"
                    [attr.aria-describedby]="id + '-help'"
                    (change)="setNumber(def, $any($event.target))"
                  />
                }
                @case ('text') {
                  <input
                    type="text"
                    class="control wide"
                    autocomplete="off"
                    spellcheck="false"
                    [id]="id"
                    [maxLength]="def.maxLength"
                    [value]="value"
                    [attr.aria-describedby]="id + '-help'"
                    (change)="setText(def, $any($event.target))"
                  />
                }
                @case ('choice') {
                  <select
                    class="control"
                    [id]="id"
                    [attr.aria-describedby]="id + '-help'"
                    (change)="set(def, $any($event.target).value)"
                  >
                    @for (v of def.values; track v) {
                      <option [value]="v" [selected]="v === value">{{ choice(def.key, v) }}</option>
                    }
                  </select>
                }
              }
              <button
                type="button"
                class="reset"
                [disabled]="isDefault(def.key)"
                [attr.aria-label]="t.resetOne(t.labels[def.key])"
                [title]="t.defaultValue(defaultText(def))"
                (click)="reset(def.key)"
              >
                ↺
              </button>
              <p class="help" [id]="id + '-help'">{{ t.help[def.key] }}</p>
            </div>
          }
          @if (previewing()) {
            <h3 class="preview-title" id="format-preview-title">{{ t.formatPreview }}</h3>
            @if (preview(); as text) {
              <pre class="preview" tabindex="0" aria-labelledby="format-preview-title">{{
                text
              }}</pre>
            } @else if (previewFailed()) {
              <p class="found">{{ t.formatPreviewFailed }}</p>
            }
          }
        </div>
      </div>
      @if (message(); as m) {
        <p class="message" [class.problem]="m.problem" role="status">{{ m.text }}</p>
      }
      <footer>
        <button type="button" (click)="resetAll()">{{ t.resetAll }}</button>
        <button type="button" (click)="exportFile()">{{ t.export }}</button>
        <button type="button" (click)="importFile()">{{ t.import }}</button>
        <span class="spacer"></span>
        <button type="button" class="primary" (click)="close()">{{ common.close }}</button>
      </footer>
    </dialog>
  `,
  styleUrl: './settings-dialog.css',
})
export class SettingsDialog implements OnInit {
  protected readonly settings = inject(SettingsService);
  private readonly actions = inject(ActionService);
  private readonly confirm = inject(ConfirmService);
  private readonly files = inject(FileDialogApi);
  private readonly textFiles = inject(SessionApi);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly searchField = viewChild.required<ElementRef<HTMLInputElement>>('search');

  readonly closed = output<void>();

  protected readonly t = SETTINGS_TEXTS;
  protected readonly common = COMMON_TEXTS;
  protected readonly groups = GROUPS;
  protected readonly group = signal<GroupId>('general');
  protected readonly query = signal('');
  protected readonly searching = computed(() => this.query().trim() !== '');
  /** The settings on screen: those the search finds, else those of the group. */
  protected readonly shown = computed<readonly SettingDef[]>(() =>
    this.searching()
      ? searchSettings(this.query())
      : SETTING_DEFS.filter((d) => d.group === this.group()),
  );
  protected readonly message = signal<{ text: string; problem: boolean } | null>(null);
  protected readonly choice = choiceLabel;
  private readonly formatter = inject(FormatService);
  /** The group of the formatter shows what its style does to a sample (prompt 023). */
  protected readonly previewing = computed(() => !this.searching() && this.group() === 'format');
  protected readonly preview = signal('');
  protected readonly previewFailed = signal(false);
  private previewAsked = 0;

  constructor() {
    effect(() => {
      if (!this.previewing()) return;
      const style = styleOf(this.settings.settings());
      const mine = ++this.previewAsked;
      this.formatter.preview(style).then(
        (text) => {
          // a later style has asked already
          if (mine !== this.previewAsked) return;
          this.preview.set(text);
          this.previewFailed.set(false);
        },
        () => {
          if (mine !== this.previewAsked) return;
          this.preview.set('');
          this.previewFailed.set(true);
        },
      );
    });
  }

  ngOnInit(): void {
    this.dialog().nativeElement.showModal();
    this.searchField().nativeElement.focus();
  }

  protected isDefault(key: SettingKey): boolean {
    return isDefault(this.settings.settings(), key);
  }

  /** The default of a setting as the user reads it. */
  protected defaultText(def: SettingDef): string {
    const value = DEFAULT_SETTINGS[def.key];
    if (def.kind === 'bool') return value ? this.t.on : this.t.off;
    if (def.kind === 'choice') return choiceLabel(def.key, String(value));
    return String(value) || '–';
  }

  protected show(group: GroupId): void {
    this.query.set('');
    this.group.set(group);
  }

  /** Up and down move between the groups and show them at once (APG tabs, vertical). */
  protected onGroupKey(event: KeyboardEvent): void {
    const at = GROUPS.indexOf(this.group());
    const to: Record<string, number> = {
      ArrowDown: (at + 1) % GROUPS.length,
      ArrowUp: (at - 1 + GROUPS.length) % GROUPS.length,
      Home: 0,
      End: GROUPS.length - 1,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this.show(GROUPS[next]);
    setTimeout(() =>
      this.dialog()
        .nativeElement.querySelector<HTMLElement>(`#settings-tab-${GROUPS[next]}`)
        ?.focus(),
    );
  }

  protected set(def: SettingDef, value: unknown): void {
    this.message.set(null);
    this.settings.update({ [def.key]: value } as Partial<Settings>);
  }

  /** A number outside its bounds is not taken: the field shows what is set. */
  protected setNumber(def: SettingDef, field: HTMLInputElement): void {
    const value = field.valueAsNumber;
    if (def.kind === 'number' && Number.isFinite(value)) {
      this.set(def, Math.min(def.max, Math.max(def.min, Math.round(value))));
    }
    field.value = String(this.settings.settings()[def.key]);
  }

  protected setText(def: SettingDef, field: HTMLInputElement): void {
    this.set(def, field.value);
    // a text the settings refuse (characters no font name has) is not taken
    field.value = String(this.settings.settings()[def.key]);
  }

  protected reset(key: SettingKey): void {
    this.settings.update(resetOf([key]));
  }

  protected async resetAll(): Promise<void> {
    const yes = await this.confirm.ask({
      title: this.t.resetAllTitle,
      message: this.t.resetAllQuestion,
      confirm: this.t.reset,
    });
    if (yes) this.settings.update(resetOf(SETTING_DEFS.map((d) => d.key)));
  }

  protected async exportFile(): Promise<void> {
    try {
      const path = await this.files.saveFile(this.t.exportTitle, this.t.exportName, JSON_FILES);
      if (path === null) return;
      await this.textFiles.writeFile(path, exportSettings(this.settings.settings()), 'utf-8');
      this.message.set({ text: this.t.exported, problem: false });
    } catch (e) {
      this.message.set({ text: describeError(e), problem: true });
    }
  }

  protected async importFile(): Promise<void> {
    try {
      const path = await this.files.openFile(this.t.importTitle, JSON_FILES);
      if (path === null) return;
      const file = await this.textFiles.readFile(path);
      const next = importSettings(file.text, this.settings.settings());
      if (next === null) {
        this.message.set({ text: this.t.notSettings, problem: true });
        return;
      }
      this.settings.update(next);
      this.message.set({ text: this.t.imported, problem: false });
    } catch (e) {
      this.message.set({ text: describeError(e), problem: true });
    }
  }

  /** The colour schemes and the shortcuts have their own dialogs: this one makes room. */
  protected run(action: 'COLOR_SCHEME' | 'OPEN_SHORTCUTS'): void {
    this.close();
    this.actions.run(action);
  }

  protected close(): void {
    this.dialog().nativeElement.close();
    this.closed.emit();
  }
}
