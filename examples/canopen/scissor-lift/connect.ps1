# Makes the four runtimes of the scissor lift example reachable from the editor on Windows at
# 127.0.0.10 - 127.0.0.13, port 8443, while this window is open. It needs no administrator rights
# and changes no system setting. The example runs on a Linux host (a Raspberry Pi or a PC); one SSH
# session forwards the four addresses to that host's ports 18443 - 18446, and the machine panel to
# http://127.0.0.1:8080:
#   powershell -ExecutionPolicy Bypass -File connect.ps1 user@host
param([Parameter(Mandatory = $true)][string]$Target)

$devices = @(
    @{ Name = "chassis-controller"; Address = "127.0.0.10"; Port = 18443 },
    @{ Name = "platform-box";       Address = "127.0.0.11"; Port = 18444 },
    @{ Name = "valve-module";       Address = "127.0.0.12"; Port = 18445 },
    @{ Name = "tilt-sensor";        Address = "127.0.0.13"; Port = 18446 }
)

$forwards = @("-L", "127.0.0.1:8080:127.0.0.1:8080")
foreach ($d in $devices) {
    $forwards += @("-L", ("{0}:8443:127.0.0.1:{1}" -f $d.Address, $d.Port))
    Write-Host ("{0,-20} {1}:8443" -f $d.Name, $d.Address)
}
Write-Host "Panel: http://127.0.0.1:8080. Press Ctrl+C to close the connection."
& ssh -N -o ExitOnForwardFailure=yes @forwards $Target
exit $LASTEXITCODE
