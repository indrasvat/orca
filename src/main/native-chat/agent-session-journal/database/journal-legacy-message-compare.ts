import type Database from '../../../sqlite/sync-database'
import { prepareJournalDomainImport } from '../journal-domain-import'
import type { OlderMessageCursor } from './journal-legacy-older-messages'

/** CI lines and other status rows, turn edges and the rows an open rewrites on its own aren't. */
export function isRealMessage(item: unknown): boolean {
  if (!isObject(item) || item.recovered === true || !isObject(item.body)) {
    return false
  }
  switch (item.body.kind) {
    case 'message':
      return item.body.role !== 'system'
    case 'tool-call':
    case 'diff':
    case 'approval':
    case 'question':
      return true
    default:
      return false
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson(text: unknown): unknown {
  try {
    return JSON.parse(String(text))
  } catch {
    return undefined
  }
}

/** Held only as the same revision of the same item, or removed here; anything else may diverge. */
export function heldItem(
  db: Database.Database,
  id: string,
  epoch: string,
  item: HeldShape,
  revision: 'same' | 'or-later' = 'same'
): boolean {
  const row = db
    .prepare(`SELECT 0 AS removed, revision, payload_json AS payload FROM journal_items
      WHERE session_id=?1 AND epoch=?2 AND item_id=?3
      UNION ALL SELECT 1, revision, NULL FROM journal_item_tombstones
      WHERE session_id=?1 AND epoch=?2 AND item_id=?3`)
    .get(id, epoch, item.itemId)
  if (!row) {
    return false
  }
  const held = Number(row.revision)
  // Removal proves only what was here before it: an item written past a revision is new text,
  // and without one only a revision below the removal's is one this chat had.
  if (row.removed === 1) {
    return revision === 'same' && item.revision < held
  }
  if (revision === 'same' ? held !== item.revision : held < item.revision) {
    return false
  }
  const payload = parseJson(row.payload)
  return isObject(payload) && sameBody(payload.body, item.body)
}

export type HeldShape = { itemId: string; revision: number; body: unknown }

export function isHeldShape(item: unknown): item is HeldShape {
  return isObject(item) && typeof item.itemId === 'string' && typeof item.revision === 'number'
}

export function sameBody(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Without a revision, the chat's whole restored history is compared: with what a converted chat
 * holds here, or with when the original was last read.
 */
export function addedBesideHeld(
  source: Database.Database,
  db: Database.Database,
  id: string,
  cursor: Exclude<OlderMessageCursor, { kind: 'revision' }>
): boolean {
  const imported = prepareJournalDomainImport(source, id)
  if (!imported) {
    return false
  }
  const held = (table: string, key: string): boolean =>
    cursor.kind === 'held' &&
    db
      .prepare(`SELECT 1 FROM ${table} WHERE session_id=? AND epoch=? AND message_id=? LIMIT 1`)
      .get(id, cursor.epoch, key) !== undefined
  // A card is held only with the same text: one edited there is the person's newer text.
  const heldCard = (card: { messageId: string; body: unknown }): boolean => {
    if (cursor.kind !== 'held') {
      return false
    }
    const row = db
      .prepare(
        'SELECT payload_json AS payload FROM journal_queue_cards WHERE session_id=? AND epoch=? AND message_id=?'
      )
      .get(id, cursor.epoch, card.messageId)
    const payload = row === undefined ? undefined : parseJson(row.payload)
    return isObject(payload) && sameBody(payload.body, card.body)
  }
  for (const page of imported.pages) {
    if (page.kind === 'items') {
      for (const { item } of page.rows) {
        if (
          isRealMessage(item) &&
          (cursor.kind === 'held'
            ? !heldItem(db, id, cursor.epoch, item)
            : item.observedAt > cursor.after)
        ) {
          return true
        }
      }
    } else if (cursor.kind === 'time') {
      // Only items carry a time; a send the older Orca accepted shows as its message item.
      continue
    } else if (page.kind === 'attempts') {
      if (
        page.rows.some(
          ({ submission }) => !held('journal_submission_attempts', submission.clientMessageId)
        )
      ) {
        return true
      }
    } else if (page.kind === 'cards') {
      if (
        page.rows.some(
          (card) => (card.state === 'waiting' || card.state === 'returned') && !heldCard(card)
        )
      ) {
        return true
      }
    }
  }
  return false
}
