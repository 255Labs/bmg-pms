// Setup helpers: read what exists at Channex and TTLock so managers pick from a list instead of typing IDs.
export function channexCatalog(roomTypesBody, ratePlansBody) {
  const rows = (b) => (Array.isArray(b?.data) ? b.data : []);
  const roomTypes = rows(roomTypesBody).map((r) => ({ id: r.id ?? r.attributes?.id, title: r.attributes?.title ?? r.title ?? r.id }));
  const ratePlans = rows(ratePlansBody).map((r) => ({
    id: r.id ?? r.attributes?.id,
    title: r.attributes?.title ?? r.title ?? r.id,
    room_type_id: r.relationships?.room_type?.data?.id ?? r.attributes?.room_type_id ?? null,
  }));
  return { roomTypes, ratePlans };
}

export function ttlockLocks(body) {
  return (body?.list ?? []).map((l) => ({ id: String(l.lockId), title: l.lockAlias || l.lockName || String(l.lockId),
    battery: l.electricQuantity ?? null, gateway: l.hasGateway === undefined ? null : Number(l.hasGateway) === 1 }));
}
