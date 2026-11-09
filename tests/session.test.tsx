// The Session DSL now comes from feather-testing-core; what this package
// contributes is the DOM adapter. These tests pin BOTH halves: the divergences
// this harness deliberately keeps (app-shaped label lookup, disabled-button
// refusal, containment assertions) and the core behaviour it inherits (chain
// traces, scoping, and the verbs this package never implemented itself).

import React, { useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { StepError, BrowserOnlyVerbError } from 'feather-testing-core'
import { Session, createSession } from '../src/session'

afterEach(cleanup)

/** Labels the way an app renders them: no htmlFor, control as a wrapper
 * sibling, required marked with a trailing asterisk. */
function WrapperForm() {
  const [saved, setSaved] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [priority, setPriority] = useState('Low')
  const [urgent, setUrgent] = useState(false)
  return (
    <div>
      <div>
        <label>
          Subject<span> *</span>
        </label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div>
        <label>Priority</label>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="Low">Low</option>
          <option value="High">High</option>
        </select>
      </div>
      <div>
        <label>Urgent</label>
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
      </div>
      <div>
        <label>Plan</label>
        <input type="radio" name="plan" value="pro" />
      </div>
      <div>
        <label htmlFor="qty">Quantity</label>
        <input id="qty" defaultValue="" />
      </div>
      <input placeholder="Search rows" />
      <button disabled={!subject} onClick={() => setSaved('HDT-00001')}>
        Save
      </button>
      {saved && <p>{saved}</p>}
    </div>
  )
}

describe('label lookup', () => {
  it('finds a control whose label is a wrapper sibling, ignoring the required marker', async () => {
    render(<WrapperForm />)
    const session = createSession()
    await session.fillIn('Subject', 'Sales mismatch').assertValue('Subject', 'Sales mismatch')
  })

  it('still finds an htmlFor-associated control', async () => {
    render(<WrapperForm />)
    await createSession().fillIn('Quantity', 'twelve').assertValue('Quantity', 'twelve')
  })

  it('accepts a number and writes it as text', async () => {
    render(<WrapperForm />)
    await createSession().fillIn('Quantity', 12).assertValue('Quantity', '12')
  })

  it('falls back to a placeholder', async () => {
    render(<WrapperForm />)
    await createSession().fillIn('Search rows', 'ticket').assertValue('Search rows', 'ticket')
  })

  it('reports the label it could not find', async () => {
    render(<WrapperForm />)
    const error = await createSession()
      .fillIn('Nope', 'x')
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error!.message).toContain('Could not find a field labelled "Nope"')
  })

  it('selectOption and check reach the same controls', async () => {
    render(<WrapperForm />)
    await createSession()
      .selectOption('Priority', 'High')
      .check('Urgent')
      .assertSelected('Priority', 'High')
      .assertChecked('Urgent')
    await createSession().uncheck('Urgent').refuteChecked('Urgent')
  })

  it('choose() reaches a radio whose label is a wrapper sibling', async () => {
    render(<WrapperForm />)
    // The radio has no accessible name, so a role lookup could never find it.
    await createSession().choose('Plan').assertChecked('Plan')
  })

  it('assertOptions is inherited from core and uses this adapter’s lookup', async () => {
    render(<WrapperForm />)
    await createSession().assertOptions('Priority', ['Low', 'High'])
  })
})

function Collision() {
  const [msg, setMsg] = useState('')
  return (
    <div>
      <nav>
        <button onClick={() => setMsg('Chip!')}>Checklist Run — checklist</button>
        <a href="/checklists">Checklist Runs</a>
      </nav>
      <main>
        <button onClick={() => setMsg('Checked!')}>Check</button>
        <a
          href="/x"
          onClick={(e) => {
            e.preventDefault()
            setMsg('Linked!')
          }}
        >
          Check
        </a>
        <div onClick={() => setMsg('Outer!')}>
          <span
            onClick={(e) => {
              e.stopPropagation()
              setMsg('Inner!')
            }}
          >
            Open
          </span>
        </div>
        <p>{msg}</p>
      </main>
    </div>
  )
}

describe('clickButton / clickLink', () => {
  it('prefers the exactly-named control over one that merely contains the name', async () => {
    render(<Collision />)
    await createSession().clickButton('Check').assertText('Checked!')
  })

  it('falls back to a containing name only when nothing matches exactly', async () => {
    render(<Collision />)
    await createSession().clickButton('Checklist Run').assertText('Chip!')
  })

  it('refuses a disabled button instead of clicking into the void', async () => {
    render(<WrapperForm />)
    const error = await createSession()
      .clickButton('Save')
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error!.message).toContain('Button "Save" is disabled')
  })

  it('clicks a button by its aria-label when its text is shorter', async () => {
    // Featherbase's import wizard: the button reads "Tick all", and its
    // aria-label says what it ticks.
    function TickAll() {
      const [msg, setMsg] = useState('')
      return (
        <div>
          <button type="button" aria-label="Tick all in the list" onClick={() => setMsg('All ticked')}>
            Tick all
          </button>
          <p>{msg}</p>
        </div>
      )
    }
    render(<TickAll />)
    await createSession().clickButton('Tick all in the list').assertText('All ticked')
  })

  it('clicks a link by name', async () => {
    render(<Collision />)
    await createSession().clickLink('Check').assertText('Linked!')
  })

  it('click() finds the innermost element carrying the text', async () => {
    render(<Collision />)
    // Both the wrapper div and the span contain "Open"; the innermost wins.
    await createSession().click('Open').assertText('Inner!')
  })
})

describe('assertions are containment checks', () => {
  it('assertText matches a prefix of a generated id', async () => {
    render(<WrapperForm />)
    await createSession().fillIn('Subject', 'x').clickButton('Save').assertText('HDT-')
  })

  it('refuteText fails when the text is present inside a longer string', async () => {
    render(<WrapperForm />)
    const error = await createSession()
      .fillIn('Subject', 'x')
      .clickButton('Save')
      .refuteText('HDT-')
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error!.message).toContain('IS on the page but should not be')
  })
})

function Scoped() {
  return (
    <div>
      <div className="sidebar">
        <div className="panel">
          <button>Delete</button>
          <p>Sidebar panel</p>
        </div>
      </div>
      <div className="main">
        <div className="panel">
          <p>Main panel</p>
        </div>
      </div>
    </div>
  )
}

describe('scoping', () => {
  it('within() confines the chain, and nests', async () => {
    render(<Scoped />)
    await createSession().within('.main', (s) => s.within('.panel', (p) => p.assertText('Main panel')))
  })

  it('a scoped chain cannot see outside its container', async () => {
    render(<Scoped />)
    const error = await createSession()
      .within('.main', (s) => s.assertText('Sidebar panel'))
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error).toBeInstanceOf(StepError)
  })

  it('a root option confines the whole session', async () => {
    const { container } = render(<Scoped />)
    const main = container.querySelector('.main') as HTMLElement
    await new Session({ root: main }).assertText('Main panel')
    const error = await new Session({ root: main })
      .assertText('Sidebar panel')
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error).toBeInstanceOf(StepError)
  })

  it('within() takes an async callback', async () => {
    render(<Scoped />)
    const seen: string[] = []
    await createSession().within('.sidebar', async (s) => {
      await s.assertText('Sidebar panel')
      seen.push('ran')
    })
    expect(seen).toEqual(['ran'])
  })
})

describe('chain failures', () => {
  it('name every step, with the failing one marked', async () => {
    render(<WrapperForm />)
    const error = await createSession()
      .fillIn('Subject', 'Sales mismatch')
      .selectOption('Priority', 'High')
      .refuteText('Subject')
      .assertText('never reached')
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )

    expect(error).toBeInstanceOf(StepError)
    const msg = error!.message
    expect(msg).toContain("[ok] fillIn('Subject', 'Sales mismatch')")
    expect(msg).toContain("[ok] selectOption('Priority', 'High')")
    expect(msg).toContain(">>> [FAILED] refuteText('Subject')")
    expect(msg).toContain("[skipped] assertText('never reached')")
  })

  it('carry steps from an earlier chain on the same session', async () => {
    render(<WrapperForm />)
    const session = createSession()
    await session.fillIn('Subject', 'first chain')

    const error = await session
      .assertText('never rendered')
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error!.message).toContain("[ok] fillIn('Subject', 'first chain')")
    expect(error!.message).toContain(">>> [FAILED] assertText('never rendered')")
  })
})

describe('core verbs this package never implemented', () => {
  it('step() hands over the adapter context', async () => {
    render(<WrapperForm />)
    let sawButton = false
    await createSession().step('poke the DOM', async ({ container }) => {
      sawButton = (await container.findByRole('button', { name: 'Save' })) !== null
    })
    expect(sawButton).toBe(true)
  })

  it('debug() prints the scope', async () => {
    render(<Scoped />)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await createSession().within('.main', (s) => s.debug())
    expect(spy.mock.calls[0][0]).toContain('Main panel')
    expect(spy.mock.calls[0][0]).not.toContain('Sidebar panel')
    spy.mockRestore()
  })
})

/** What core 0.5 and 0.6 added to the DSL, reached through this adapter. */
function Totals() {
  const [count, setCount] = useState(1)
  return (
    <div>
      <div className="total" data-palette="ivory" data-ready="">
        Total: {count}
      </div>
      <button onClick={() => setCount(10)}>Add nine</button>
    </div>
  )
}

describe('verbs core 0.6 adds', () => {
  it('assertExactText compares the scope’s whole text', async () => {
    render(<Totals />)
    await createSession().within('.total', (t) => t.assertExactText('Total: 1'))
  })

  it('assertExactText rejects text that only contains the expected text', async () => {
    render(<Totals />)
    const error = await createSession()
      .clickButton('Add nine')
      .within('.total', (t) => t.assertExactText('Total: 1', { timeout: 100 }))
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error!.message).toContain("found 'Total: 10'")
  })

  it('assertAttribute checks the scope’s attribute value', async () => {
    render(<Totals />)
    await createSession().within('.total', (t) =>
      t.assertAttribute('data-palette', 'ivory').assertAttribute('data-ready'),
    )
  })

  it('refuteAttribute fails on an attribute the scope has', async () => {
    render(<Totals />)
    const error = await createSession()
      .within('.total', (t) => t.refuteAttribute('data-palette', { timeout: 100 }))
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error!.message).toContain("expected attribute 'data-palette' to be absent")
  })

  it.each([
    ['reload', (s: Session) => s.reload()],
    ['assertComputedStyle', (s: Session) => s.assertComputedStyle('color', 'red')],
    ['assertNoHorizontalOverflow', (s: Session) => s.assertNoHorizontalOverflow()],
    ['assertHorizontalOverflow', (s: Session) => s.assertHorizontalOverflow()],
    ['assertHorizontallyContained', (s: Session) => s.assertHorizontallyContained('.total')],
    ['scrollToHorizontalEnd', (s: Session) => s.scrollToHorizontalEnd()],
  ])('%s() names itself as browser-only', async (verb, run) => {
    render(<Totals />)
    const error = await run(createSession()).then(
      () => null,
      (e: unknown) => e as StepError,
    )
    expect(error!.cause).toBeInstanceOf(BrowserOnlyVerbError)
    expect(error!.message).toContain(`${verb}()`)
  })

  it('hides a value typed into a password field in the failure report', async () => {
    render(
      <div>
        <label>Login code</label>
        <input type="password" />
      </div>,
    )
    const error = await createSession()
      .fillIn('Login code', 'hunter2')
      .assertText('never shown')
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error!.message).not.toContain('hunter2')
  })
})

describe('secrets', () => {
  it('fillIn passes the sensitive option through to core', async () => {
    render(<WrapperForm />)
    const error = await createSession()
      .fillIn('Subject', 'recovery phrase words', { sensitive: true })
      .assertText('never shown')
      .then(
        () => null,
        (e: unknown) => e as StepError,
      )
    expect(error!.message).toContain("fillIn('Subject', '••••••')")
  })

  it('debug() hides a password input’s value', async () => {
    function Login() {
      const [pw, setPw] = useState('')
      return (
        <div>
          <label>Code</label>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
      )
    }
    render(<Login />)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await createSession().fillIn('Code', 'hunter2').debug()
    const printed = spy.mock.calls.map((c) => String(c[0])).join('\n')
    spy.mockRestore()
    expect(printed).not.toContain('hunter2')
  })
})

/** Tasker's task detail (example-apps/tasker/src/TaskManagement.tsx): each
 * select sits inside its label and also carries its own aria-label. */
function TaskDetail() {
  const [state, setState] = useState('Not started')
  const [store, setStore] = useState('')
  return (
    <div>
      <label>
        State
        <select aria-label="Task state" value={state} onChange={(e) => setState(e.target.value)}>
          {['Not started', 'In progress', 'Done'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Store
        <select aria-label="Task store" value={store} onChange={(e) => setStore(e.target.value)}>
          <option value="">No store</option>
          <option value="s1">Keelkattalai Store</option>
          <option value="s2">Velachery Store</option>
        </select>
      </label>
    </div>
  )
}

describe('label lookup: nesting and ARIA names', () => {
  it('finds a select nested in its label, whose name leaves out the option texts', async () => {
    render(<TaskDetail />)
    await createSession().selectOption('State', 'In progress').assertSelected('State', 'In progress')
  })

  it('finds a select named only by its aria-label', async () => {
    render(<TaskDetail />)
    await createSession().selectOption('Task store', 'Velachery Store').assertSelected('Task store', 'Velachery Store')
  })

  it('finds a control named by aria-labelledby', async () => {
    // Featherbase's bar pickers and grouped fields: a span names the control.
    render(
      <div>
        <span id="view-label">View</span>
        <select aria-labelledby="view-label" defaultValue="All">
          <option>All</option>
          <option>Mine</option>
        </select>
      </div>,
    )
    await createSession().selectOption('View', 'Mine').assertSelected('View', 'Mine')
  })

  it('reads a Featherbase form field whose label holds a required marker and a help button', async () => {
    // FormView.tsx: the label wraps the name in a span the control points at,
    // then an aria-hidden "*" and the glossary's "?" button.
    function FormField() {
      const [title, setTitle] = useState('')
      const [done, setDone] = useState(false)
      return (
        <div>
          <div>
            <label htmlFor="f-title">
              <span id="f-title-label">Title</span>
              <span aria-hidden="true"> *</span>
              <span>
                <button type="button">?</button>
              </span>
            </label>
            <input id="f-title" aria-labelledby="f-title-label" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="f-done">
              <span id="f-done-label">Done</span>
            </label>
            <label>
              <input
                type="checkbox"
                id="f-done"
                aria-labelledby="f-done-label"
                checked={done}
                onChange={(e) => setDone(e.target.checked)}
              />
            </label>
          </div>
        </div>
      )
    }
    render(<FormField />)
    await createSession()
      .fillIn('Title', 'Sales mismatch')
      .check('Done')
      .assertValue('Title', 'Sales mismatch')
      .assertChecked('Done')
  })

  it('assertOptions lists a nested select’s options under its label', async () => {
    render(<TaskDetail />)
    await createSession().assertOptions('Store', ['No store', 'Keelkattalai Store', 'Velachery Store'])
  })
})
