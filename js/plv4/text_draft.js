// Keep Library provenance beside an uncommitted native/Monaco draft. Offsets
// follow subsequent edits; editing inside a completed prompt retires its source.
export function draftCompletions(before, after, completions, completion = null) {
  let start = 0, end = before.length, nextEnd = after.length;
  while (start < end && start < nextEnd && before[start] === after[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  const delta = nextEnd - end;
  const retained = completions.flatMap(value => {
    const [a, b] = value.span;
    if (end <= a) return [{ ...value, span: [a + delta, b + delta] }];
    if (start >= b) return [value];
    return [];
  });
  if (completion) retained.push(structuredClone(completion));
  return retained;
}
