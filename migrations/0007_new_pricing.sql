-- New price list. Prices are stored as whole PLN.
ALTER TABLE services ADD COLUMN price_pln INTEGER NOT NULL DEFAULT 0;

-- Existing services are updated by id (not by name) so that existing
-- appointments keep pointing at the same rows.
UPDATE services SET name = 'Strzyżenie', duration_minutes = 40, price_pln = 60, sort_order = 1 WHERE id = 1;
UPDATE services SET name = 'Broda', duration_minutes = 30, price_pln = 40, sort_order = 3 WHERE id = 3;
UPDATE services SET name = 'Combo (strzyżenie + broda)', duration_minutes = 60, price_pln = 100, sort_order = 4 WHERE id = 2;

-- New services.
INSERT INTO services (name, duration_minutes, active, sort_order, price_pln) VALUES
  ('Same boki', 30, 1, 2, 50),
  ('Coverowanie + broda', 50, 1, 5, 70),
  ('Combo + coverowanie brody', 90, 1, 6, 130);
