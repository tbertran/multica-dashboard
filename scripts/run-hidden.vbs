Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")
appDir = objFSO.GetParentFolderName(objFSO.GetParentFolderName(WScript.ScriptFullName))
objShell.CurrentDirectory = appDir
objShell.Run "node src\server.js", 0, False
