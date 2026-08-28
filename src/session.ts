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
// assertOptions, upload, dropFile, step() — come along for free.

import { waitFor, prettyDOM } from '@testing-library/dom'
import type userEvent from '@testing-library/user-event'
import {
  RTLDriver,
  Session as CoreSession,
  type RTLStepContext,
} from 'feather-testing-core/rtl'
import type { TestDriver } from 'feather-testing-core'

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

const normalize = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** The visible name of a clickable: its text, or an input's `value`. */
function clickableName(el: HTMLElement): string {
  if (el instanceof HTMLInputElement) return normalize(el.value)
  return normalize(el.textContent)
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
 *   `*` is not part of the field's name.
 * - `choose` — by label, for the same reason: a radio whose label is a wrapper
 *   sibling has no accessible name for a role lookup to match.
 * - `clickButton` / `clickLink` / `click` — named by visible text rather than
 *   accessible name, exact match first and a containing match only as an
 *   ordered fallback. `clickButton` additionally refuses a disabled button
 *   instead of clicking into the void, the most common false pass in a form
 *   test.
 * - `assertText` / `refuteText` — containment checks over the rendered text, so
 *   `assertText('TICK-')` can assert a generated id's prefix.
 */
export class DomDriver extends RTLDriver {
  constructor(opts: SessionOptions = {}, user?: UserApi) {
    super(user, opts.root ?? document.body, opts.timeout ?? DEFAULT_TIMEOUT)
  }

  protected override scoped(element: HTMLElement): TestDriver<RTLStepContext> {
    return new DomDriver({ root: element, timeout: this.timeout }, this.user)
  }

  /** Retry a lookup until it yields an element or the timeout expires. */
  protected async find<T extends Element>(
    describe: string,
    get: () => T | null,
  ): Promise<T> {
    try {
      return await waitFor(
        () => {
          const el = get()
          if (!el) throw new Error(`Could not find ${describe}`)
          return el
        },
        { timeout: this.timeout, container: this.rootElement() },
      )
    } catch (e) {
      throw new Error(`Could not find ${describe}`, { cause: e })
    }
  }

  /** Label text -> its form control. Handles htmlFor-associated labels AND the
   * common "label and input are siblings in a wrapper div" layout. */
  protected override findField(label: string): Promise<HTMLElement> {
    return this.find(`a field labelled ${j(label)}`, () => {
      const root = this.rootElement()
      for (const l of Array.from(root.querySelectorAll('label'))) {
        // A trailing "*" is a required marker, not part of the field's name.
        const text = normalize(l.textContent).replace(/\s*\*$/, '')
        if (text !== label) continue
        if (l instanceof HTMLLabelElement && l.control) return l.control
        // control nested inside the label
        const nested = l.querySelector('input, textarea, select')
        if (nested && isFormControl(nested)) return nested as HTMLElement
        // control as a sibling within the same wrapper
        const sibling = l.parentElement?.querySelector('input, textarea, select')
        if (sibling && isFormControl(sibling)) return sibling as HTMLElement
      }
      // placeholder fallback
      const byPlaceholder = root.querySelector(`[placeholder=${JSON.stringify(label)}]`)
      if (byPlaceholder) return byPlaceholder as HTMLElement
      return null
    })
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

  override async clickButton(name: string): Promise<void> {
    const el = await this.find(`a button ${j(name)}`, () =>
      this.byName(
        Array.from(
          this.rootElement().querySelectorAll<HTMLElement>(
            'button, [role="button"], input[type="submit"]',
          ),
        ),
        name,
      ),
    )
    if (el instanceof HTMLButtonElement && el.disabled)
      throw new Error(`Button ${j(name)} is disabled — a user could not click it`)
    await this.user.click(el)
  }

  /** By label, not by accessible name: a radio whose label is a wrapper
   * sibling has no accessible name at all, so core's role lookup would never
   * find it in the markup this adapter exists for. */
  override async choose(label: string): Promise<void> {
    const radio = await this.findField(label)
    if (!(radio instanceof HTMLInputElement))
      throw new Error(`Field ${j(label)} is not an input`)
    if (!radio.checked) await this.user.click(radio)
    this.lastFormElement = radio.closest('form')
  }

  override async clickLink(name: string): Promise<void> {
    const el = await this.find(`a link ${j(name)}`, () =>
      this.byName(Array.from(this.rootElement().querySelectorAll<HTMLElement>('a')), name),
    )
    await this.user.click(el)
  }

  override async click(text: string): Promise<void> {
    const el = await this.find(`an element with text ${j(text)}`, () => {
      const all = Array.from(this.rootElement().querySelectorAll<HTMLElement>('*'))
      // innermost element whose own text matches
      const matches = all.filter((n) => normalize(n.textContent).includes(text))
      return matches.length ? matches[matches.length - 1] : null
    })
    await this.user.click(el)
  }

  override async assertText(text: string): Promise<void> {
    await waitFor(
      () => {
        const content = this.rootElement().textContent ?? ''
        if (!content.includes(text)) throw new Error(`Text ${j(text)} not found on the page`)
      },
      { timeout: this.timeout, container: this.rootElement() },
    )
  }

  override async refuteText(text: string): Promise<void> {
    // Let pending renders settle, then require absence.
    await new Promise((r) => setTimeout(r, 50))
    const content = this.rootElement().textContent ?? ''
    if (content.includes(text)) throw new Error(`Text ${j(text)} IS on the page but should not be`)
  }

  override async debug(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(prettyDOM(this.rootElement(), 20000))
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
  override fillIn(label: string, value: string | number): this {
    return super.fillIn(label, String(value))
  }
}

export function createSession(opts: SessionOptions = {}): Session {
  return new Session(opts)
}

export { StepError } from 'feather-testing-core'
export type { RTLStepContext as SessionStepContext } from 'feather-testing-core/rtl'
