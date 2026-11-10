/** Checks a welded triangle surface for a consistently oriented, sealed shell. */
export function analyzeMeshTopology(positions: ArrayLike<number>, triangles: ArrayLike<number>) {
  const edges = new Map<string, number>();
  let sixTimesVolume = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
    if (a === b || b === c || c === a) return { closed: false, signedVolume: 0 };
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = `${from},${to}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    sixTimesVolume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  const closed = triangles.length >= 12 && [...edges].every(([key, count]) => {
    const [a, b] = key.split(",");
    return count === 1 && edges.get(`${b},${a}`) === 1;
  });
  return { closed: closed && Math.abs(sixTimesVolume) > 1e-12, signedVolume: sixTimesVolume / 6 };
}
