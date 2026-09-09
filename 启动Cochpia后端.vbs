Option Explicit

Dim shell, projectDir, nodePath, command
Set shell = CreateObject("WScript.Shell")
projectDir = "C:\Users\umi\Documents\ChatGPT\陪伴Cochpia"
nodePath = "C:\Program Files\nodejs\node.exe"
command = """" & nodePath & """ """ & projectDir & "\server\index.js"""
shell.CurrentDirectory = projectDir
shell.Run command, 0, False
Set shell = Nothing
