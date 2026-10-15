import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase, rpc } from './supabase';
import { setFormats, setPrivileges } from './format';

// admin_notes is for platform administrators only, so the app names its columns
const PROPERTY_COLUMNS = 'id, name, code, group_name, address, phone, email, tin, vrn, currency, tax_rate, tax_inclusive, check_in_time, check_out_time, business_date, next_res_no, next_folio_no, created_at, next_receipt_no, next_bill_no, timezone, status, status_reason, features, property_type, star_rating, website, fax, reservation_phone, reg_numbers, address_line2, city, region, postal_code, country, latitude, longitude, logo_url, highlights, amenities, policies, settings';

const Ctx = createContext(null);
export const useProperty = () => useContext(Ctx);

const KEY = 'bmg-pms-property';

export function PropertyProvider({ session, children }) {
  const [properties, setProperties] = useState(null);
  const [currentId, setCurrentId] = useState(() => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  });
  const [property, setProperty] = useState(null);
  const EMPTY = { roomTypes: [], rooms: [], ratePlans: [], sources: [], companies: [], paymentMethods: [], extraCharges: [], discountTypes: [],
    marketSegments: [], reservationTypes: [], transportTypes: [], mealPlans: [], remarks: [], guestAttributes: [], payoutTypes: [], holidays: [] };
  const [lookups, setLookups] = useState(EMPTY);
  const [mfaBlocked, setMfaBlocked] = useState([]);
  const [billingBlocked, setBillingBlocked] = useState([]); // locked for an unpaid BMG subscription
  const [privs, setPrivs] = useState(null); // what this person may do here (from the database)
  const [version, setVersion] = useState(0); // bump to refresh pages after a change

  const [isAdmin, setIsAdmin] = useState(false);
  const loadProperties = useCallback(async () => {
    // invites waiting for this email become memberships at sign-in
    await rpc('pms_claim_invites').catch(() => 0);
    rpc('pms_is_super_admin').then((v) => setIsAdmin(!!v)).catch(() => setIsAdmin(false));
    rpc('pms_record_sign_in').catch(() => {});
    const blocked = await rpc('pms_mfa_blocked_properties').catch(() => []) ?? [];
    setMfaBlocked(blocked);
    setBillingBlocked(await rpc('pms_billing_blocked_properties').catch(() => []) ?? []);
    // a property that requires two-step sign-in stays out of the list until this session has it
    const rows = ((await rpc('pms_group_snapshot')) ?? []).filter((r) => !blocked.some((b) => b.property_id === r.property_id));
    setProperties(rows);
    return rows;
  }, []);

  useEffect(() => { loadProperties(); }, [loadProperties, session?.user?.id]);

  useEffect(() => {
    if (!properties?.length) return;
    if (!currentId || !properties.some((p) => p.property_id === currentId)) {
      setCurrentId(properties[0].property_id);
    }
  }, [properties, currentId]);

  const loadProperty = useCallback(async () => {
    if (!currentId) return;
    try { localStorage.setItem(KEY, currentId); } catch { /* storage unavailable */ }
    const list = (t, order = 'name') => supabase.from(t).select('*').eq('property_id', currentId).order(order);
    const [{ data: p }, rt, rooms, plans, sources, companies, pm, ec, dt, ms, rtyp, tt, mp, rem, ga, po, hol, privs] = await Promise.all([
      supabase.from('pms_properties').select(PROPERTY_COLUMNS).eq('id', currentId).single(),
      supabase.from('pms_room_types').select('*').eq('property_id', currentId).order('sort_order').order('name'),
      supabase.from('pms_rooms').select('*').eq('property_id', currentId).order('number'),
      supabase.from('pms_rate_plans').select('*').eq('property_id', currentId).order('name'),
      supabase.from('pms_business_sources').select('*').eq('property_id', currentId).order('name'),
      supabase.from('pms_companies').select('*').eq('property_id', currentId).order('name'),
      list('pms_payment_methods', 'sort_order'), list('pms_extra_charges'), list('pms_discount_types'), list('pms_market_segments'),
      list('pms_reservation_types'), list('pms_transport_types'), list('pms_meal_plans', 'code'), list('pms_remarks', 'text'),
      list('pms_guest_attributes'), list('pms_payout_types'), list('pms_holidays', 'holiday_date'),
      supabase.rpc('pms_my_privileges', { p_property: currentId }),
    ]);
    setFormats(p?.settings ?? {});
    setPrivileges(privs.error ? null : privs.data ?? []);
    setPrivs(privs.data ?? null);
    setProperty(p);
    setLookups({
      roomTypes: rt.data ?? [], rooms: rooms.data ?? [], ratePlans: plans.data ?? [],
      sources: sources.data ?? [], companies: companies.data ?? [],
      paymentMethods: pm.data ?? [], extraCharges: ec.data ?? [], discountTypes: dt.data ?? [], marketSegments: ms.data ?? [],
      reservationTypes: rtyp.data ?? [], transportTypes: tt.data ?? [], mealPlans: mp.data ?? [], remarks: rem.data ?? [],
      guestAttributes: ga.data ?? [], payoutTypes: po.data ?? [], holidays: hol.data ?? [],
    });
  }, [currentId]);

  useEffect(() => { loadProperty(); }, [loadProperty, version]);

  const role = properties?.find((p) => p.property_id === currentId)?.role ?? null;

  const value = {
    session, user: session.user, properties, property, role, lookups, isAdmin, mfaBlocked, billingBlocked, privs,
    switchProperty: setCurrentId,
    reloadProperties: loadProperties,
    refresh: () => setVersion((v) => v + 1),
    version,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
