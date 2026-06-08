-- Fix uploaded_by column type: users.id is UUID not INTEGER
ALTER TABLE fridge_contracts
  ALTER COLUMN uploaded_by TYPE UUID USING NULL;
