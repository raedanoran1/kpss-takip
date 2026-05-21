@echo off
title KPSS Takip Sunucu
cd /d "%~dp0"
echo KPSS Takip baslatiliyor...
echo Adres: https://192.168.1.36:8080
node server.js
