' Hidden launcher for the class website server (no window will be shown)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
sh.Run """" & folder & "\start-server.bat""", 0, False
