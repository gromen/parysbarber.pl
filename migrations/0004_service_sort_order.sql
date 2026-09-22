ALTER TABLE services ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE services SET sort_order = 1 WHERE name = 'Strzyżenie';
UPDATE services SET sort_order = 2 WHERE name = 'Strzyżenie brody';
UPDATE services SET sort_order = 3 WHERE name = 'Strzyżenie + broda';
