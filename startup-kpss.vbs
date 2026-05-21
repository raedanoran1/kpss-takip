Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & WScript.ScriptFullName & "\..\start-kpss.bat" & Chr(34), 0, False
Set WshShell = Nothing
