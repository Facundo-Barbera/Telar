"use client";

import { useState } from "react";
import { SmartphoneIcon } from "lucide-react";
import { PushNotificationsGroup } from "@/features/push";
import { Row, SettingsGroup, ToggleRow } from "@/features/settings";
import { useRemoteStatus } from "../hooks/use-remote-status";
import { RemoteDevicesGroup, RevokeOthersRow } from "./remote-devices-group";
import { RemoteEnvironmentGroup } from "./remote-environment-group";
import { RemotePairGroup } from "./remote-pair-group";

export function RemoteSection() {
  const remote = useRemoteStatus();
  const { status, error } = remote;
  const [endpointUrl, setEndpointUrl] = useState<string | null>(null);

  if (!status) {
    return (
      <SettingsGroup title="Pairing">
        <Row label="Loading" hint="Reading the pairing store." {...(error ? { error } : {})} control={null} />
      </SettingsGroup>
    );
  }

  return (
    <>
      <SettingsGroup title="Pairing">
        <ToggleRow
          label="Require pairing"
          icon={SmartphoneIcon}
          hint={
            error ??
            (status.requireAuth
              ? "Unpaired devices are refused. The app running the server is always in."
              : "Anything that can reach this address has full control. The tailnet ACL is the only boundary.")
          }
          checked={status.requireAuth}
          onCheckedChange={(next) => void remote.toggle(next)}
        />
      </SettingsGroup>

      {status.requireAuth && (
        <RemoteEnvironmentGroup
          status={status}
          restartNeeded={remote.restartNeeded}
          onExposure={(next) => void remote.setExposure(next)}
          onTailscaleServe={(next) => void remote.setTailscaleServe(next)}
        />
      )}

      {status.requireAuth && (
        <RemotePairGroup
          minted={remote.minted}
          endpoints={status.endpoints}
          busy={remote.busy}
          onMint={() => void remote.mint()}
          endpointUrl={endpointUrl}
          onSelectEndpoint={setEndpointUrl}
        />
      )}

      <RemoteDevicesGroup
        status={status}
        busy={remote.busy}
        onRename={(id, name) => void remote.patchDevice(id, { name })}
        onRole={(id, role) => void remote.patchDevice(id, { role })}
        onRevoke={(id) => void remote.revoke(id)}
      />

      <PushNotificationsGroup />

      {status.devices.length > 1 && status.callerDeviceId && (
        <SettingsGroup title="Danger">
          <RevokeOthersRow count={status.devices.length - 1} onConfirm={() => void remote.revokeOthers()} />
        </SettingsGroup>
      )}
    </>
  );
}
