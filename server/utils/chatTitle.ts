import type { UIMessage } from 'ai';

export const DEFAULT_CHAT_TITLE = 'Untitled chat';

const CHAT_TITLE_TARGET_LENGTH = 30;
const CHAT_TITLE_MAX_WORD_LENGTH = 50;
const GENERATED_CHAT_TITLE_MAX_LENGTH = 48;
const GENERATED_CHAT_MAX_SINGLE_WORD_LENGTH = GENERATED_CHAT_TITLE_MAX_LENGTH;
const GENERATED_CHAT_TITLE_MAX_WORDS = 8;

export function getFirstUserText(messages: UIMessage[]): string | undefined {
  const first = messages.find((message) => message.role === 'user');
  return first?.parts?.find((part): part is { type: 'text'; text: string } =>
    typeof part === 'object' && part !== null && 'type' in part && (part as { type: string }).type === 'text',
  )?.text;
}

export function createDefaultChatTitle(text: string | undefined): string {
  const normalized = normalizeTitleText(text);
  if (!normalized) return DEFAULT_CHAT_TITLE;
  return shortenAtWordBoundary(normalized, CHAT_TITLE_TARGET_LENGTH, CHAT_TITLE_MAX_WORD_LENGTH);
}

export function cleanGeneratedChatTitle(text: string | undefined): string | null {
  const firstLine = text?.split(/\r?\n/).find((line) => line.trim());
  const normalized = normalizeTitleText(firstLine)
    ?.replace(/^[-*]\s+/, '')
    ?.replace(/^Title:\s*/i, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  if (!normalized) return null;

  const shortened = shortenAtWordBoundary(
    normalized,
    GENERATED_CHAT_TITLE_MAX_LENGTH,
    GENERATED_CHAT_MAX_SINGLE_WORD_LENGTH,
  );

  if (shortened !== normalized && !/\s/.test(normalized[shortened.length] ?? '')) return null;
  if (shortened.split(/\s+/).length > GENERATED_CHAT_TITLE_MAX_WORDS) return null;
  return shortened;
}

function normalizeTitleText(text: string | undefined): string | undefined {
  return text?.replace(/\s+/g, ' ').trim();
}

function shortenAtWordBoundary(text: string, targetLength: number, maxSingleWordLength: number): string {
  if (text.length <= targetLength) return text;

  const previousBoundary = text.lastIndexOf(' ', targetLength);
  const nextBoundary = text.indexOf(' ', targetLength);

  const candidates = [
    previousBoundary > 0 ? text.slice(0, previousBoundary) : undefined,
    nextBoundary > 0 ? text.slice(0, nextBoundary) : undefined,
  ].filter((value): value is string => !!value);

  const best = candidates.sort((left, right) =>
    Math.abs(targetLength - left.length) - Math.abs(targetLength - right.length),
  )[0];

  if (best) return best;

  const firstWord = text.split(' ')[0] ?? DEFAULT_CHAT_TITLE;
  return firstWord.length <= maxSingleWordLength
    ? firstWord
    : firstWord.slice(0, targetLength).trim() || DEFAULT_CHAT_TITLE;
}
