"use client";

import { useState } from "react";
import { FieldLabel } from "@/components/ui";
import { deriveDefaultAccountName } from "@/lib/account-defaults";

const ACCOUNT_TYPES = ["IRA", "Taxable", "Paper", "Manual"];

export function NewAccountNameAndTypeFields({ userName, inputClass }: { userName: string; inputClass: string }) {
  const [accountType, setAccountType] = useState("IRA");
  const [name, setName] = useState(() => deriveDefaultAccountName(userName, "IRA"));
  const [nameTouched, setNameTouched] = useState(false);

  return (
    <>
      <div className="space-y-2">
        <FieldLabel>Name</FieldLabel>
        <input
          name="name"
          required
          value={name}
          onChange={(event) => {
            setNameTouched(true);
            setName(event.target.value);
          }}
          className={inputClass}
        />
      </div>
      <div className="space-y-2">
        <FieldLabel>Type</FieldLabel>
        <select
          name="accountType"
          value={accountType}
          onChange={(event) => {
            const nextType = event.target.value;
            setAccountType(nextType);
            if (!nameTouched) {
              setName(deriveDefaultAccountName(userName, nextType));
            }
          }}
          className={inputClass}
        >
          {ACCOUNT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
