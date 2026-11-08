# Makes the four runtimes of the scissor lift example reachable from the editor on Windows at
# 127.0.0.10 - 127.0.0.13, port 8443, while this window is open. It needs no administrator rights
# and changes no system setting.
#   powershell -ExecutionPolicy Bypass -File connect.ps1
#       relays each address to the port WSL forwards from the Linux distribution (run.sh up
#       publishes 18443 - 18446)
#   powershell -ExecutionPolicy Bypass -File connect.ps1 user@host
#       the example runs on another Linux host: one SSH session forwards the four addresses to
#       that host's ports 18443 - 18446, and the machine panel to http://127.0.0.1:8080
param([string]$Target)

$devices = @(
    @{ Name = "chassis-controller"; Address = "127.0.0.10"; Port = 18443 },
    @{ Name = "platform-box";       Address = "127.0.0.11"; Port = 18444 },
    @{ Name = "valve-module";       Address = "127.0.0.12"; Port = 18445 },
    @{ Name = "tilt-sensor";        Address = "127.0.0.13"; Port = 18446 }
)

if ($Target) {
    $forwards = @("-L", "127.0.0.1:8080:127.0.0.1:8080")
    foreach ($d in $devices) {
        $forwards += @("-L", ("{0}:8443:127.0.0.1:{1}" -f $d.Address, $d.Port))
        Write-Host ("{0,-20} {1}:8443" -f $d.Name, $d.Address)
    }
    Write-Host "Panel: http://127.0.0.1:8080. Press Ctrl+C to close the connection."
    & ssh -N -o ExitOnForwardFailure=yes @forwards $Target
    exit $LASTEXITCODE
}

Add-Type -TypeDefinition @"
using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;

public static class LiftRelay
{
    public static void Start(string listenAddress, int listenPort, string targetHost, int targetPort)
    {
        TcpListener listener = new TcpListener(IPAddress.Parse(listenAddress), listenPort);
        listener.Start();
        Thread accept = new Thread(delegate ()
        {
            while (true)
            {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); }
                catch (Exception) { return; }
                TcpClient accepted = client;
                ThreadPool.QueueUserWorkItem(delegate (object state) { Pump(accepted, targetHost, targetPort); });
            }
        });
        accept.IsBackground = true;
        accept.Start();
    }

    static void Pump(TcpClient client, string host, int port)
    {
        try
        {
            using (client)
            using (TcpClient upstream = new TcpClient())
            {
                upstream.Connect(host, port);
                NetworkStream a = client.GetStream();
                NetworkStream b = upstream.GetStream();
                Thread back = new Thread(delegate ()
                {
                    try { b.CopyTo(a); } catch (Exception) { }
                    try { client.Client.Shutdown(SocketShutdown.Send); } catch (Exception) { }
                });
                back.IsBackground = true;
                back.Start();
                try { a.CopyTo(b); } catch (Exception) { }
                try { upstream.Client.Shutdown(SocketShutdown.Send); } catch (Exception) { }
                back.Join();
            }
        }
        catch (Exception) { }
    }
}
"@

foreach ($d in $devices) {
    [LiftRelay]::Start($d.Address, 8443, "127.0.0.1", $d.Port)
    Write-Host ("{0,-20} {1}:8443" -f $d.Name, $d.Address)
}
Write-Host "Relaying. Press Ctrl+C to stop."
while ($true) { Start-Sleep -Seconds 3600 }
