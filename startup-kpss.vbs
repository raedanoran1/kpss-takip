Dim WshShell, scriptDir
Set WshShell = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
WshShell.Run Chr(34) & scriptDir & "start-kpss.bat" & Chr(34), 0, False
Set WshShell = Nothing
