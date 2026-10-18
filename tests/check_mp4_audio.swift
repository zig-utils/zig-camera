// Independent AVFoundation demux/decode and edit-list playback timing check.
import AVFoundation
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
let tracks = try await asset.loadTracks(withMediaType: .audio)
precondition(tracks.count == 1)
let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
reader.add(output)
precondition(reader.startReading())
var total = 0
var first: Double? = nil
var end = 0.0
let file = URL(fileURLWithPath: CommandLine.arguments[2])
_ = FileManager.default.createFile(atPath: file.path, contents: nil)
let handle = try FileHandle(forWritingTo: file)
while let sample = output.copyNextSampleBuffer() {
    total += CMSampleBufferGetNumSamples(sample)
    let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
    if first == nil { first = time }
    end = time + CMSampleBufferGetDuration(sample).seconds
    if let block = CMSampleBufferGetDataBuffer(sample) {
        let length = CMBlockBufferGetDataLength(block)
        var data = Data(count: length)
        let result = data.withUnsafeMutableBytes { raw in CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!) }
        precondition(result == kCMBlockBufferNoErr)
        try handle.write(contentsOf: data)
    }
}
try handle.close()
precondition(reader.status == .completed, String(describing: reader.error))
print("AVFoundation audio: \(total) frames, start \(first ?? -1), end \(end)")
if CommandLine.arguments.count >= 4 { if total != Int(CommandLine.arguments[3])! { fputs("presented sample count differs: \(total) expected \(CommandLine.arguments[3])\n", stderr); exit(1) } }
if CommandLine.arguments.count >= 5 { if abs((first ?? -1) - Double(CommandLine.arguments[4])!) >= 0.000025 { fputs("audio start offset differs\n", stderr); exit(1) } }
