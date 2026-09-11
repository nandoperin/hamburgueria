const db = require('./client');

/** Atualização pequena e idempotente para aceitar cash sem marcar como pago. */
async function aplicar() {
  await db.query(`
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS change_for NUMERIC(10,2);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'orders'::regclass AND conname = 'orders_status_check'
           AND pg_get_constraintdef(oid) LIKE '%cash_due%'
      ) THEN
        ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
        ALTER TABLE orders ADD CONSTRAINT orders_status_check
          CHECK (status IN ('pending', 'awaiting_review', 'paid', 'cash_due', 'printed',
                            'delivered', 'rejected', 'cancelled'));
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'payments'::regclass AND conname = 'payments_status_check'
           AND pg_get_constraintdef(oid) LIKE '%cash_due%'
      ) THEN
        ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
        ALTER TABLE payments ADD CONSTRAINT payments_status_check
          CHECK (status IN ('pending', 'awaiting_review', 'review_reminded',
                            'paid', 'cash_due', 'rejected'));
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_orders_printable_claim
      ON orders(status, print_claimed_at, created_at)
      WHERE status IN ('paid', 'cash_due');

    CREATE OR REPLACE FUNCTION notify_printer_order_paid()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' AND NEW.status IN ('paid', 'cash_due') THEN
        PERFORM pg_notify('printer_orders', NEW.id::text);
      ELSIF TG_OP = 'UPDATE' AND NEW.status IN ('paid', 'cash_due')
        AND OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM pg_notify('printer_orders', NEW.id::text);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

module.exports = { aplicar };
