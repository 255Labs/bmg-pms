// Occupancy audit findings: short name and what it means
export const AUDIT_KIND = {
  used_while_vacant: ['Used while vacant', 'A person or a guest code in a room with no guest booked in'],
  not_checked_in: ['Not checked in', 'Activity in a room whose booking was never checked in'],
  before_check_in: ['Before check-in', 'Activity well before the guest was checked in'],
  after_check_out: ['After check-out', 'Activity well after the guest was checked out'],
  unknown_code: ['Unknown code', 'A door code the PMS never issued for that room'],
  checked_out_unpaid: ['Left owing', 'Checked out with money still owed'],
  in_house_unpaid: ['Nothing paid', 'In house past the first night with no payment at all'],
  occupied_no_activity: ['No activity', 'Checked in, but no door or camera activity all day'],
};
