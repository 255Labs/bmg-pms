# Tenda ICO → BMG PMS: charge to room

Tenda ICO stays the restaurant and bar till. When a guest says "put it on my room", the cashier picks
**Room charge** as the payment method, finds the guest by room number or name, and the bill lands on
the guest's folio in the PMS at once. The guest settles everything at check-out.

## How it fits

```
Tenda ICO till  →  pms-proxy (Tenda ICO's Supabase, checks the cashier's login)
                →  pos-gateway (BMG PMS Supabase, checks the API key)  →  guest folio
```

## Set up (once per property)

1. In BMG PMS: **Integrations → Tenda ICO → Create key**. Name it after the outlet. Copy the key; it is shown once.
2. In the Tenda ICO Supabase project:
   ```bash
   supabase secrets set BMG_PMS_URL=https://<pms-ref>.supabase.co/functions/v1/pos-gateway BMG_PMS_KEY=bmgpms_...
   supabase functions deploy pms-proxy      # copy integrations/tendaico into supabase/functions first
   ```
3. In Tenda ICO, add a payment method **Room charge** that:
   - calls `pms-proxy` with `action: 'guests'` to show in-house guests (room · name);
   - on confirm, calls `action: 'charge'` with `billRef` = the Tenda ICO sale id, `stayId` and `room` from the chosen guest,
     `amount` = sale total, `outlet`, and `items` (`[{ name, qty, amount }]`);
   - stores the returned `charge_id` on the sale;
   - when a room-charged sale is voided the same day, calls `action: 'void'` with the sale id and a reason.

## Rules the PMS enforces

| Situation | Response |
|---|---|
| Same `billRef` sent again | 200 with the first result. Never a second charge. |
| Same `billRef`, different amount | 409 `CONFLICT` |
| Guest not checked in, or checked out | 409 `NOT_IN_HOUSE` |
| Guest moved rooms since the list was loaded | 409 `ROOM_MISMATCH`, reload the list |
| Void after the night audit closed that day | 409 `DAY_CLOSED`, the front desk adjusts it |
| Missing or revoked key | 401 |

Charges arrive as category `fnb` unless you send another department: `recreation` (gym, pool, games room),
`spa`, `tours`, `events`, `laundry`, `minibar`, `transport`, `damage` or `other`. So a Tenda ICO till at the pool
or gym can charge a day pass or a towel to the room and it shows on the folio under Recreation.

Limits: `bill_ref` is 1–64 letters, digits or `. : - / #`; `amount` is above 0 and at most 100,000,000 with two
decimals at most; `description` and item names are cut to 200 and 80 characters.
Each call is logged under Integrations → Activity in the PMS.
