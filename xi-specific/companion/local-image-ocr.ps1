$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try{
 Add-Type -AssemblyName System.Runtime.WindowsRuntime
 $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Storage.Streams.DataWriter,Windows.Foundation,ContentType=WindowsRuntime]
 $null=[Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
 $awaitMethod=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'} | Select-Object -First 1
 function Await($operation,$type){$task=$awaitMethod.MakeGenericMethod($type).Invoke($null,@($operation));if(-not $task.Wait(6000)){throw 'timeout'};return $task.Result}
 $raw=[Console]::In.ReadToEnd()
 if($raw.Length -gt 100000){throw 'input limit'}
 $request=$raw | ConvertFrom-Json
 if(@($request.PSObject.Properties.Name).Count -ne 1 -or -not $request.base64){throw 'invalid input'}
 $bytes=[Convert]::FromBase64String($request.base64)
 if($bytes.Length -gt 49152){throw 'thumbnail limit'}
 $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
 $writer=New-Object Windows.Storage.Streams.DataWriter($stream)
 $writer.WriteBytes($bytes);$null=Await ($writer.StoreAsync()) ([uint32]);$null=$writer.DetachStream();$stream.Seek(0)
 $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
 if($decoder.PixelWidth -gt 768 -or $decoder.PixelHeight -gt 768){throw 'dimension limit'}
 $bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
 $bitmap=[Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap,[Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
 $language=New-Object Windows.Globalization.Language('zh-Hans-CN')
 $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
 if(-not $engine){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
 if(-not $engine){throw 'language unavailable'}
 $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
 $text=[string]$result.Text
 if($text.Length -gt 2000){$text=$text.Substring(0,2000)}
 @{status='ok';mode='local-ocr';text=$text;language=$engine.RecognizerLanguage.LanguageTag;uncertainty='OCR can miss or misread text; thumbnail and first frame only.'} | ConvertTo-Json -Compress
}catch{
 @{status='unavailable';mode='local-ocr';reason='local-ocr-failed-or-unavailable'} | ConvertTo-Json -Compress
}finally{
 if($bitmap){$bitmap.Dispose()};if($writer){$writer.Dispose()};if($stream){$stream.Dispose()}
}
