import type { ExtractedKnowledgeCard } from './extraction.ts'

const NUMERIC_OR_MODEL = /(?:\d+[A-Za-z][A-Za-z0-9._-]*|\d+(?:[.,]\d+)?(?:%|％|ms|s|Hz|kHz|MHz|GHz|MB|GB|dB|V|A|W)?|[A-Za-z]{1,12}[-_]?[0-9][A-Za-z0-9._-]*)/gu
const ACRONYM = /(?<![A-Za-z0-9])(?:[A-Z][A-Z0-9]{1,11})(?![A-Za-z0-9])/gu

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, '')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export interface GroundingValidation {
  valid: boolean
  issues: string[]
  unsupported_tokens: string[]
}

export class GroundingValidator {
  validate(card: ExtractedKnowledgeCard, sourceText: string, allowedContext: string[] = []): GroundingValidation {
    const source = normalized([sourceText, ...allowedContext].join('\n'))
    const generated = [card.title, card.concept, card.core_claim, card.explanation, ...card.keywords,
      ...card.relations.map(relation => relation.target)].join('\n')
    const protectedTokens = unique([
      ...(generated.match(NUMERIC_OR_MODEL) ?? []),
      ...(generated.match(ACRONYM) ?? []),
    ])
    const unsupported = protectedTokens.filter(token => {
      const candidate = normalized(token)
      if (source.includes(candidate)) return false
      if (/^[A-Z]{2,12}$/u.test(token) && [...token].every(letter => source.includes(normalized(letter)))) return false
      return true
    })
    return {
      valid: unsupported.length === 0,
      issues: unsupported.map(token => `unsupported_protected_token:${token}`),
      unsupported_tokens: unsupported,
    }
  }
}
