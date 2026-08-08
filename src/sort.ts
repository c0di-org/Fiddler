/**
 * Digit-aware, case-insensitive name compare, so `file2` sorts before `file10`
 * and `v1.9` before `v1.10`. Mirrors the ordering the backend applies.
 */
export function natural(a: string, b: string): number {
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const ac = a[i];
    const bc = b[j];
    const aDigit = ac >= "0" && ac <= "9";
    const bDigit = bc >= "0" && bc <= "9";

    if (aDigit && bDigit) {
      let ai = i;
      while (ai < a.length && a[ai] >= "0" && a[ai] <= "9") ai++;
      let bj = j;
      while (bj < b.length && b[bj] >= "0" && b[bj] <= "9") bj++;

      // Compare by numeric value; long runs stay exact because we compare the
      // digit strings rather than parsing them into floats.
      const an = a.slice(i, ai).replace(/^0+(?=\d)/, "");
      const bn = b.slice(j, bj).replace(/^0+(?=\d)/, "");
      if (an.length !== bn.length) return an.length - bn.length;
      if (an !== bn) return an < bn ? -1 : 1;

      i = ai;
      j = bj;
      continue;
    }

    const al = ac.toLowerCase();
    const bl = bc.toLowerCase();
    if (al !== bl) return al < bl ? -1 : 1;
    i++;
    j++;
  }

  return a.length - i - (b.length - j);
}
