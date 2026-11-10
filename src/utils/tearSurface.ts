import * as THREE from "three";

type Vertex = { position: THREE.Vector3; uv?: THREE.Vector2 };

function clip(triangle: Vertex[], plane: THREE.Plane, side: number): Vertex[] {
  const result: Vertex[] = [];
  for (let i = 0; i < triangle.length; i += 1) {
    const start = triangle[i], end = triangle[(i + 1) % triangle.length];
    const d0 = plane.distanceToPoint(start.position) * side;
    const d1 = plane.distanceToPoint(end.position) * side;
    if (d0 >= -1e-8) result.push(start);
    if ((d0 < -1e-8 && d1 > 1e-8) || (d0 > 1e-8 && d1 < -1e-8)) {
      const t = d0 / (d0 - d1);
      result.push({
        position: start.position.clone().lerp(end.position, t),
        uv: start.uv && end.uv ? start.uv.clone().lerp(end.uv, t) : undefined,
      });
    }
  }
  return result;
}

/** Split an open triangle surface in its local coordinates, retaining UVs. */
export function tearSurface(geometry: THREE.BufferGeometry, plane: THREE.Plane): [THREE.BufferGeometry, THREE.BufferGeometry] | null {
  const position = geometry.getAttribute("position");
  if (!position) throw new Error("Tearing requires a position attribute");
  const uv = geometry.getAttribute("uv"), index = geometry.getIndex();
  const positions = [[], []] as number[][];
  const uvs = [[], []] as number[][];
  const read = (i: number): Vertex => ({
    position: new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)),
    uv: uv ? new THREE.Vector2(uv.getX(i), uv.getY(i)) : undefined,
  });
  const append = (side: number, polygon: Vertex[]) => {
    for (let i = 1; i + 1 < polygon.length; i += 1) {
      const tri = [polygon[0], polygon[i], polygon[i + 1]];
      const area = new THREE.Vector3().subVectors(tri[1].position, tri[0].position)
        .cross(new THREE.Vector3().subVectors(tri[2].position, tri[0].position)).lengthSq();
      if (area < 1e-14) continue;
      for (const vertex of tri) {
        positions[side].push(...vertex.position.toArray());
        if (vertex.uv) uvs[side].push(...vertex.uv.toArray());
      }
    }
  };
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const triangle = [read(index?.getX(i) ?? i), read(index?.getX(i + 1) ?? i + 1), read(index?.getX(i + 2) ?? i + 2)];
    append(0, clip(triangle, plane, 1));
    append(1, clip(triangle, plane, -1));
  }
  if (!positions[0].length || !positions[1].length) return null;
  return positions.map((values, i) => {
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
    if (uv) result.setAttribute("uv", new THREE.Float32BufferAttribute(uvs[i], 2));
    return result;
  }) as [THREE.BufferGeometry, THREE.BufferGeometry];
}
