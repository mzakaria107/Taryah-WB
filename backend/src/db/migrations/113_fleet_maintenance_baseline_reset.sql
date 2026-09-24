-- One-time reset: baseline every vehicle's maintenance schedule at its
-- CURRENT odometer reading instead of the 0 every row was seeded with at
-- creation/bulk-import. Before this, "km_since_service" was really
-- "km since the vehicle was ever created" for any vehicle with no real
-- maintenance history logged yet — which is why almost every bulk-imported
-- vehicle showed up as overdue on nearly every maintenance type ("تنبيهات
-- صيانة" = 5) despite never actually having a completed service logged.
-- Requested explicitly: "اجعل القراءة الحالية المدخلة هي البداية لحساب
-- الصيانة" — treat today's odometer as the fresh starting point. Runs once
-- (migrations never re-run), and only touches last_service_km, not
-- last_service_date — we genuinely don't know when these vehicles were
-- last serviced, so that column is deliberately left as-is (NULL) rather
-- than fabricating a service date. Going forward, POST /vehicles and the
-- Excel bulk-importer both seed NEW vehicles' schedules at their own
-- starting odometer (see fleet.js), and every completed
-- POST /vehicles/:id/maintenance already rolls last_service_km/date
-- forward in the same transaction — so this bulk UPDATE is a one-time
-- catch-up for vehicles that existed before that behavior was fixed, not
-- an ongoing mechanism.
UPDATE fleet_maintenance_schedule ms
SET last_service_km = v.current_odometer_km
FROM fleet_vehicles v
WHERE ms.vehicle_id = v.id;
