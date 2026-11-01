// Prints, as JSON, the values another reader sees in each DCF: every ParameterValue by
// "0xIIII:SS" and [DeviceComissioning]. Compared with the editor's own reading.
using System.Globalization;
using System.Text.Json;
using EdsDcfNet;

var result = new List<object>();
foreach (var path in args)
{
    try
    {
        var dcf = CanOpenFile.Dcf.ReadFile(path);
        var values = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var obj in dcf.ObjectDictionary.Objects.Values)
        {
            if (!string.IsNullOrEmpty(obj.ParameterValue))
                values[Key(obj.Index, 0)] = obj.ParameterValue;
            foreach (var sub in obj.SubObjects.Values)
                if (!string.IsNullOrEmpty(sub.ParameterValue))
                    values[Key(obj.Index, sub.SubIndex)] = sub.ParameterValue;
        }
        var c = dcf.DeviceCommissioning;
        result.Add(new
        {
            file = Path.GetFileName(path),
            values,
            commissioning = new { nodeId = c.NodeId, nodeName = c.NodeName, baudrate = c.Baudrate },
        });
    }
    catch (Exception e)
    {
        result.Add(new { file = Path.GetFileName(path), error = $"{e.GetType().Name}: {e.Message}" });
    }
}
Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));

static string Key(ushort index, byte sub) =>
    string.Format(CultureInfo.InvariantCulture, "0x{0:X4}:{1:X2}", index, sub);
