# Makes the four runtimes of the scissor lift example reachable from the editor on Windows at
# 127.0.0.10 - 127.0.0.13, port 8443, while this window is open. It relays each address to the port
# WSL forwards from the Linux distribution (run.sh up publishes 18443 - 18446). It needs no
# administrator rights and changes no system setting. Start it with:
#   powershell -ExecutionPolicy Bypass -File connect.ps1
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

$devices = @(
    @{ Name = "chassis-controller"; Address = "127.0.0.10"; Port = 18443 },
    @{ Name = "platform-box";       Address = "127.0.0.11"; Port = 18444 },
    @{ Name = "valve-module";       Address = "127.0.0.12"; Port = 18445 },
    @{ Name = "tilt-sensor";        Address = "127.0.0.13"; Port = 18446 }
)
foreach ($d in $devices) {
    [LiftRelay]::Start($d.Address, 8443, "127.0.0.1", $d.Port)
    Write-Host ("{0,-20} {1}:8443" -f $d.Name, $d.Address)
}
Write-Host "Relaying. Press Ctrl+C to stop."
while ($true) { Start-Sleep -Seconds 3600 }
