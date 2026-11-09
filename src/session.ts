// The fluent Session DSL for driving a rendered UI in tests. The chain, its
// step bookkeeping and its failure messages all come from feather-testing-core
// — this module contributes only the DOM adapter, i.e. the lookups that differ
// because this harness drives app markup rather than textbook markup.
//
//   await session
//     .fillIn('Title', 'Sales mismatch')
//     .clickButton('Save')
//     .assertText('TICK-')
//
// Everything core's RTL adapter already does correctly is inherited, so verbs
// this package never implemented — assertValue, assertChecked, assertSelected,
// assertOptions, assertExactText, assertAttribute, upload, dropFile, step() —
// come along for free.

import { waitFor, prettyDOM } from '@testing-library/dom'
import type userEvent from '@testing-library/user-event'
import {
  RTLDriver,
  Session as CoreSession,
  type RTLStepContext,
} from 'feather-testing-core/rtl'
import type { AssertionOptions, FillInOptions, TestDriver } from 'feather-testing-core'

type UserApi = ReturnType<typeof userEvent.setup>

export interface SessionOptions {
  root?: HTMLElement
  /** Per-lookup timeout in ms (default 3000). */
  timeout?: number
}

/** Longer than RTL's own 1000ms default: a lookup here is usually waiting on a
 * real round trip through the in-process app to the sandboxed database. */
const DEFAULT_TIMEOUT = 3000

const j = (s: unknown) => JSON.stringify(s)

/** How core prints a secret value. */
const HIDDEN_VALUE = '••••••'

const normalize = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** The visible name of a clickable: its text, or an input's `value`. */
function clickableName(el: HTMLElement): string {
  if (el instanceof HTMLInputElement) return normalize(el.value)
  return normalize(el.textContent)
}

/** Elements whose text is a value, not a name: a label leaves them out, so
 * `<label>Store<select>…</select></label>` is named "Store", not "Store" plus
 * every option. The same list Testing Library's label lookup uses. */
const NAMED_ELEMENTS = new Set(['BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA', 'INPUT'])

/** A label's own text, without the text of controls nested inside it. */
function labelText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof Element && NAMED_ELEMENTS.has(node.tagName)) return ''
  return Array.from(node.childNodes, labelText).join('')
}

function isFormControl(el: Element): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  )
}

/**
 * Core's RTL driver, retargeted at app markup.
 *
 * Each override below exists because the stock lookup gives a wrong answer
 * against the UIs this harness drives — not because the DSL differs:
 *
 * - `findField` — app labels are frequently plain `<label>Subject *</label>`
 *   siblings inside a wrapper `<div>`, with no `htmlFor` and no nesting. RTL's
 *   `findByLabelText` cannot associate those, and the trailing required-marker
 *   `*` is not part of the field's name. Nested labels, `aria-label` and
 *   `aria-labelledby` are resolved here too, so one lookup names every field.
 * - `choose` — by label, for the same reason: a radio whose label is a wrapper
 *   sibling has no accessible name for a role lookup to match.
 * - `clickButton` / `clickLink` / `click` — named by visible text rather than
 *   accessible name, exact match first and a containing match only as an
 *   ordered fallback. `clickButton` additionally refuses a disabled button
 *   instead of clicking into the void, the most common false pass in a form
 *   test.
 * - `assertText` / `refuteText` — containment checks over the rendered text, so
 *   `assertText('TICK-')` can assert a generated id's prefix. Both wait within
 *   the step's budget: `refuteText` until the text is gone.
 * - `fillIn` — core's, except inside a shadow root, where user-event's
 *   `clear()` cannot focus the field.
 *
 * Every lookup searches core's `scopeRoots()`: inside `within()` a shadow
 * host, that is the host's open shadow root as well as its light-DOM
 * (slotted) children.
 */
export class DomDriver extends RTLDriver {
  constructor(opts: SessionOptions = {}, user?: UserApi) {
    super(user, opts.root ?? document.body, opts.timeout ?? DEFAULT_TIMEOUT)
  }

  protected override scoped(element: HTMLElement): TestDriver<RTLStepContext> {
    return new DomDriver({ root: element, timeout: this.timeout }, this.user)
  }

  /** Every element `selector` matches in scope: under the scope element and,
   * when it is a shadow host, in its open shadow root. Light-DOM children a
   * host slots in are under the element, so they are in scope too. */
  protected all<T extends Element = HTMLElement>(selector: string): T[] {
    return this.scopeRoots().flatMap((r) => Array.from(r.querySelectorAll<T>(selector)))
  }

  /** The scope's text, its shadow tree's included. */
  protected scopeText(): string {
    return this.scopeRoots()
      .map((r) => r.textContent ?? '')
      .join(' ')
  }

  /** Retry a lookup until it yields an element or the timeout expires. */
  protected async find<T extends Element>(
    describe: string,
    get: () => T | null,
    opts?: AssertionOptions,
  ): Promise<T> {
    try {
      return await waitFor(
        () => {
          const el = get()
          if (!el) throw new Error(`Could not find ${describe}`)
          return el
        },
        { timeout: this.budget(opts) },
      )
    } catch (e) {
      throw new Error(`Could not find ${describe}`, { cause: e })
    }
  }

  /** Name -> its form control: a label (htmlFor, nested, or a wrapper
   * sibling), then the control's aria-label, its aria-labelledby, and last
   * its placeholder. */
  protected override findField(label: string, opts?: AssertionOptions): Promise<HTMLElement> {
    return this.find(`a field labelled ${j(label)}`, () => {
      for (const l of this.all('label')) {
        // A trailing "*" is a required marker, not part of the field's name.
        const text = normalize(labelText(l)).replace(/\s*\*$/, '')
        if (text !== label) continue
        if (l instanceof HTMLLabelElement && l.control) return l.control
        // control nested inside the label
        const nested = l.querySelector('input, textarea, select')
        if (nested && isFormControl(nested)) return nested as HTMLElement
        // control as a sibling within the same wrapper
        const sibling = l.parentElement?.querySelector('input, textarea, select')
        if (sibling && isFormControl(sibling)) return sibling as HTMLElement
      }
      // a control named by its own aria-label
      for (const control of this.all('[aria-label]')) {
        if (isFormControl(control) && normalize(control.getAttribute('aria-label')) === label)
          return control as HTMLElement
      }
      // a control named by the elements its aria-labelledby points at
      for (const control of this.all('[aria-labelledby]')) {
        if (!isFormControl(control)) continue
        // ids resolve in the control's own tree: a shadow root, or the document
        const tree = control.getRootNode() as Document | ShadowRoot
        const name = (control.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((id) => tree.getElementById(id))
          .map((el) => (el ? labelText(el) : ''))
          .join(' ')
        if (normalize(name) === label) return control as HTMLElement
      }
      // placeholder fallback
      return this.all(`[placeholder=${JSON.stringify(label)}]`)[0] ?? null
    }, opts)
  }

  /** Exact name first, then a containing name — an ordered fallback, so the
   * lookup can never be ambiguous the way a bare substring match is. */
  private byName<T extends HTMLElement>(candidates: T[], name: string): T | null {
    return (
      candidates.find((el) => clickableName(el) === name) ??
      candidates.find((el) => clickableName(el).includes(name)) ??
      null
    )
  }

  /** A button whose aria-label is exactly `name`: Featherbase's import wizard
   * shows "Tick all" on a button named "Tick all in the list". Asked only
   * after the visible text, so a name a user can read still wins. */
  private byAriaLabel(selector: string, name: string): HTMLElement | null {
    return (
      this.all(selector).find(
        (el) => normalize(el.getAttribute('aria-label')) === name,
      ) ?? null
    )
  }

  override async clickButton(name: string, opts?: AssertionOptions): Promise<void> {
    const el = await this.find(`a button ${j(name)}`, () =>
      this.byName(this.all('button, [role="button"], input[type="submit"]'), name) ?? this.byAriaLabel('button, [role="button"], input[type="submit"]', name),
      opts,
    )
    if (el instanceof HTMLButtonElement && el.disabled)
      throw new Error(`Button ${j(name)} is disabled — a user could not click it`)
    await this.user.click(el)
  }

  /** Core's fillIn, except for a field inside a shadow root: user-event's
   * clear() requires `document.activeElement` to be the field, and for a
   * shadow field it is the host. There the old value is selected and typed
   * over instead (an empty value is a Backspace over it). */
  override async fillIn(label: string, value: string, opts?: AssertionOptions): Promise<void> {
    const field = await this.findField(label, opts)
    if (!(field.getRootNode() instanceof ShadowRoot)) return super.fillIn(label, value, opts)
    this.lastFilledField = field
    const old = (field as HTMLInputElement | HTMLTextAreaElement).value ?? ''
    await this.user.type(field, value ? value.replace(/[{[]/g, '$&$&') : '{Backspace}', {
      initialSelectionStart: 0,
      initialSelectionEnd: old.length,
    })
    this.lastFormElement = field.closest('form')
  }

  /** By label, not by accessible name: a radio whose label is a wrapper
   * sibling has no accessible name at all, so core's role lookup would never
   * find it in the markup this adapter exists for. */
  override async choose(label: string, opts?: AssertionOptions): Promise<void> {
    const radio = await this.findField(label, opts)
    if (!(radio instanceof HTMLInputElement))
      throw new Error(`Field ${j(label)} is not an input`)
    if (!radio.checked) await this.user.click(radio)
    this.lastFormElement = radio.closest('form')
  }

  override async clickLink(name: string, opts?: AssertionOptions): Promise<void> {
    const el = await this.find(
      `a link ${j(name)}`,
      () => this.byName(this.all('a'), name),
      opts,
    )
    await this.user.click(el)
  }

  override async click(text: string, opts?: AssertionOptions): Promise<void> {
    const el = await this.find(`an element with text ${j(text)}`, () => {
      // innermost element whose own text matches
      const matches = this.all('*').filter((n) => normalize(n.textContent).includes(text))
      return matches.length ? matches[matches.length - 1] : null
    }, opts)
    await this.user.click(el)
  }

  override async assertText(text: string, opts?: AssertionOptions): Promise<void> {
    await waitFor(
      () => {
        if (!this.scopeText().includes(text)) throw new Error(`Text ${j(text)} not found on the page`)
      },
      { timeout: this.budget(opts) },
    )
  }

  /** Eventually absent, as core's refute is, but by containment: passes once
   * the scope's text no longer contains `text`, fails after the budget. */
  override async refuteText(text: string, opts?: AssertionOptions): Promise<void> {
    const timeout = this.budget(opts)
    await waitFor(
      () => {
        if (this.scopeText().includes(text))
          throw new Error(`refuteText('${text}'): still present after ${timeout} ms in the scope's text`)
      },
      { timeout, onTimeout: (error) => error },
    )
  }

  /** A longer print than core's, with password values hidden as core hides
   * them: React writes a controlled input's value into its `value` attribute. */
  override async debug(): Promise<void> {
    const copy = this.rootElement().cloneNode(true) as HTMLElement
    for (const input of Array.from(copy.querySelectorAll('input[type="password"]'))) {
      if (input.hasAttribute('value')) input.setAttribute('value', HIDDEN_VALUE)
    }
    // eslint-disable-next-line no-console
    console.log(prettyDOM(copy, 20000))
  }
}

/**
 * Core's Session, bound to the DOM adapter above and constructed from
 * `SessionOptions` rather than a driver instance.
 */
export class Session extends CoreSession<RTLStepContext> {
  constructor(opts: SessionOptions = {}) {
    super(new DomDriver(opts))
  }

  /** Numbers are a convenience for numeric fields; the DOM only ever sees a
   * string. */
  override fillIn(label: string, value: string | number, opts?: FillInOptions): this {
    return super.fillIn(label, String(value), opts)
  }
}

export function createSession(opts: SessionOptions = {}): Session {
  return new Session(opts)
}

export { StepError } from 'feather-testing-core'
export type { RTLStepContext as SessionStepContext } from 'feather-testing-core/rtl'
