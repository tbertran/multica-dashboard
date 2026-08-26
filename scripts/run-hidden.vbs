Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\Thomas\claude-home\multica-dashboard"
objShell.Run "node src\server.js", 0, False
