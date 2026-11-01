// Prints, as JSON, what another reader sees in each file: for a DCF or XDC every ParameterValue
// (actualValue) by "0xIIII:SS" and the commissioning, for an XDD every object's DefaultValue.
// Compared with the editor's own reading.
using System.Globalization;
using System.Text.Json;
using EdsDcfNet;

var result = new List<object>();
foreach (var path in args)
{
    try
    {
        if (path.EndsWith(".xdd", StringComparison.OrdinalIgnoreCase))
        {
            var xdd = CanOpenFile.Xdd.ReadFile(path);
            var objects = new SortedDictionary<string, string>(StringComparer.Ordinal);
            foreach (var obj in xdd.ObjectDictionary.Objects.Values)
            {
                if (obj.SubObjects.Count == 0)
                    objects[Key(obj.Index, 0)] = obj.DefaultValue ?? "";
                foreach (var sub in obj.SubObjects.Values)
                    objects[Key(obj.Index, sub.SubIndex)] = sub.DefaultValue ?? "";
            }
            result.Add(new { file = Path.GetFileName(path), objects });
            continue;
        }
        var dcf = path.EndsWith(".xdc", StringComparison.OrdinalIgnoreCase)
            ? CanOpenFile.Xdc.ReadFile(path)
            : CanOpenFile.Dcf.ReadFile(path);
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
