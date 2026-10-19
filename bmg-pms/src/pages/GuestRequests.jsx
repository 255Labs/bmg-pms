import { useState } from 'react';
import { useProperty } from '../lib/property.jsx';
import { PageHead, Tabs, Empty } from '../components/ui.jsx';
import { RequestCard, useGuestRequests } from '../components/GuestRequests.jsx';

// Everything guests have asked for through the portal: new and accepted first, then the last 12 hours
export default function GuestRequestsPage() {
  const { property } = useProperty();
  const { list, open, enabled } = useGuestRequests();
  const [tab, setTab] = useState('open');
  const [kind, setKind] = useState('all');
  const base = tab === 'open' ? open : list.filter((r) => !['new', 'accepted'].includes(r.status));
  const rows = base.filter((r) => kind === 'all' || (kind === 'food' ? r.kind === 'food' : r.kind !== 'food'));
  const portalOn = property.settings?.guest_portal?.enabled;
  return (
    <>
      <PageHead title="Guest requests" sub="Food orders and service requests from the guest portal. New ones pop up on every screen and ring once." />
      {!portalOn && <p className="note">Links go out at check-in once the portal is switched on under Setup → Guest portal. You can also send one from any checked-in booking.</p>}
      {!enabled ? <Empty>You do not have access to guest requests.</Empty> : <>
        <div className="gr-filters">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'open', label: `Waiting (${open.length})` }, { value: 'closed', label: 'Finished today' }]} />
          <div className="seg gr-kind" role="group" aria-label="Kind">
            {[['all', 'All'], ['food', 'Food'], ['service', 'Services']].map(([k, l]) => (
              <button key={k} className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? <Empty>{tab === 'open' ? 'Nothing waiting. New requests appear here by themselves.' : 'Nothing finished in the last 12 hours.'}</Empty>
          : <div className="gr-grid">{rows.map((r) => <RequestCard key={r.id} r={r} />)}</div>}
      </>}
    </>
  );
}
