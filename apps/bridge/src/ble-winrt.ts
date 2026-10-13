/**
 * Windows Runtime GATT peripheral. UUIDs come from POCKETPILOT_BLE_SERVICE / _RX / _TX
 * so they stay in lockstep with `BLE_IDS` in @pocketpilot/remote.
 * Stdin is a line of JSON: {"op":"tx","d":"<base64>"} or {"op":"stop"}.
 * Stdout is a line of JSON: ready | error | rx | link | log.
 */
export const WINRT_SCRIPT = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$script:gate = New-Object System.Object

function Emit([string]$line) {
  [System.Threading.Monitor]::Enter($script:gate)
  try {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  } finally {
    [System.Threading.Monitor]::Exit($script:gate)
  }
}

function Escape([string]$text) {
  if (-not $text) { return "" }
  return $text.Replace([char]34, "'").Replace([char]10, " ").Replace([char]13, " ")
}

function Await($op, $resultType) {
  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1
  }
  $arg = $resultType
  if (-not $arg) { $arg = $op.GetType().GenericTypeArguments[0] }
  if (-not $arg) { throw "AsTask result type unresolved" }
  $task = $methods[0].MakeGenericMethod(@($arg)).Invoke($null, @($op))
  $task.Wait()
  if ($task.IsFaulted) { throw $task.Exception.GetBaseException() }
  return $task.Result
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProvider, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicParameters, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProviderAdvertisingParameters, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]

try {
  if (-not $env:POCKETPILOT_BLE_SERVICE) { throw "missing service id" }
  $serviceUuid = [guid]$env:POCKETPILOT_BLE_SERVICE
  $rxUuid = [guid]$env:POCKETPILOT_BLE_RX
  $txUuid = [guid]$env:POCKETPILOT_BLE_TX
  $created = Await ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProvider]::CreateAsync($serviceUuid)) [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProviderResult]
  if ($created.Error.ToString() -ne "Success") { throw ("radio " + $created.Error.ToString()) }
  $provider = $created.ServiceProvider
  $service = $provider.Service

  $rxParams = New-Object Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicParameters
  $rxProps = [int][Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]::Write -bor [int][Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]::WriteWithoutResponse
  $rxParams.CharacteristicProperties = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]$rxProps
  $rxParams.WriteProtectionLevel = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattProtectionLevel]::Plain
  $rxResult = Await ($service.CreateCharacteristicAsync($rxUuid, $rxParams)) [Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicResult]
  if ($rxResult.Error.ToString() -ne "Success") { throw ("rx " + $rxResult.Error.ToString()) }
  $rx = $rxResult.Characteristic

  $txParams = New-Object Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicParameters
  $txProps = [int][Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]::Notify
  $txParams.CharacteristicProperties = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties]$txProps
  $txResult = Await ($service.CreateCharacteristicAsync($txUuid, $txParams)) [Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicResult]
  if ($txResult.Error.ToString() -ne "Success") { throw ("tx " + $txResult.Error.ToString()) }
  $script:txChar = $txResult.Characteristic

  $rx.add_WriteRequested({
    param($sender, $args)
    $deferral = $args.GetDeferral()
    try {
      $req = Await ($args.GetRequestAsync()) [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteRequest]
      $reader = [Windows.Storage.Streams.DataReader]::FromBuffer($req.Value)
      $len = [int]$reader.UnconsumedBufferLength
      $bytes = New-Object byte[] $len
      if ($len -gt 0) { $reader.ReadBytes($bytes) }
      Emit ('{"e":"rx","d":"' + [Convert]::ToBase64String($bytes) + '"}')
      if ($req.Option.ToString() -eq "WriteWithResponse") { $req.Respond() }
    } catch {
      Emit ('{"e":"log","m":"' + (Escape $_.Exception.Message) + '"}')
    } finally {
      $deferral.Complete()
    }
  })

  $script:txChar.add_SubscribedClientsChanged({
    param($sender, $args)
    try {
      $clients = @($sender.SubscribedClients)
      $n = $clients.Count
      $mtu = 20
      if ($n -gt 0 -and $clients[0].MaxNotificationSize) { $mtu = [int]$clients[0].MaxNotificationSize }
      if ($mtu -lt 20) { $mtu = 20 }
      Emit ('{"e":"link","n":' + $n + ',"mtu":' + $mtu + '}')
    } catch {
      Emit ('{"e":"log","m":"' + (Escape $_.Exception.Message) + '"}')
    }
  })

  $adv = New-Object Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProviderAdvertisingParameters
  $adv.IsConnectable = $true
  $adv.IsDiscoverable = $true
  $provider.StartAdvertising($adv)
  Emit '{"e":"ready"}'

  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq "") { continue }
    $msg = $null
    try { $msg = $line | ConvertFrom-Json } catch { continue }
    if ($msg.op -eq "stop") { break }
    if ($msg.op -eq "tx" -and $msg.d) {
      try {
        $raw = [Convert]::FromBase64String([string]$msg.d)
        $writer = New-Object Windows.Storage.Streams.DataWriter
        $writer.WriteBytes([byte[]]$raw)
        $buffer = $writer.DetachBuffer()
        $null = Await ($script:txChar.NotifyValueAsync($buffer)) [System.Collections.Generic.IReadOnlyList[[Windows.Devices.Bluetooth.GenericAttributeProfile.GattClientNotificationResult, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]]]
      } catch {
        Emit ('{"e":"log","m":"' + (Escape $_.Exception.Message) + '"}')
      }
    }
  }
  try { $provider.StopAdvertising() } catch {}
  Emit '{"e":"stop"}'
} catch {
  Emit ('{"e":"error","m":"' + (Escape $_.Exception.Message) + '"}')
  exit 1
}
`;
