// The Session DSL now comes from feather-testing-core; what this package
// contributes is the DOM adapter. These tests pin BOTH halves: the divergences
// this harness deliberately keeps (app-shaped label lookup, disabled-button
// refusal, containment assertions) and the core behaviour it inherits (chain
// traces, scoping, and the verbs this package never implemented itself).

import React, { useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { StepError } from 'feather-testing-core'
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
