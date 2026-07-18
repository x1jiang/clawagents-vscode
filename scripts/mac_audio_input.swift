#!/usr/bin/env swift
/// List / get / set the macOS default audio input device (CoreAudio).
/// Usage:
///   mac_audio_input.swift list
///   mac_audio_input.swift get
///   mac_audio_input.swift set <deviceId>
import Foundation
import CoreAudio

func deviceName(_ id: AudioDeviceID) -> String {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceNameCFString,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size = UInt32(MemoryLayout<CFString?>.stride)
  var name: CFString?
  let status = withUnsafeMutablePointer(to: &name) { ptr in
    AudioObjectGetPropertyData(
      id, &address, 0, nil, &size, ptr
    )
  }
  if status == noErr, let name = name as String? {
    return name
  }
  return "Device \(id)"
}

func isInput(_ id: AudioDeviceID) -> Bool {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamConfiguration,
    mScope: kAudioDevicePropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr,
        size > 0
  else {
    return false
  }
  let raw = UnsafeMutableRawPointer.allocate(
    byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment
  )
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else {
    return false
  }
  let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1).pointee
  guard list.mNumberBuffers > 0 else { return false }
  var channels: UInt32 = 0
  withUnsafePointer(to: list.mBuffers) { bufPtr in
    let buffers = UnsafeBufferPointer(
      start: bufPtr, count: Int(list.mNumberBuffers)
    )
    for b in buffers {
      channels += b.mNumberChannels
    }
  }
  return channels > 0
}

func allDeviceIds() -> [AudioDeviceID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else {
    return []
  }
  let count = Int(size) / MemoryLayout<AudioDeviceID>.size
  var ids = [AudioDeviceID](repeating: 0, count: count)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else {
    return []
  }
  return ids
}

func defaultInputId() -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var id: AudioDeviceID = 0
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id
  )
  return status == noErr ? id : nil
}

func setDefaultInput(_ id: AudioDeviceID) -> Bool {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var value = id
  let size = UInt32(MemoryLayout<AudioDeviceID>.size)
  return AudioObjectSetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, size, &value
  ) == noErr
}

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : "list"

switch cmd {
case "list":
  let current = defaultInputId()
  for id in allDeviceIds() where isInput(id) {
    let mark = (current == id) ? "1" : "0"
    print("\(id)\t\(mark)\t\(deviceName(id))")
  }
case "get":
  if let id = defaultInputId() {
    print("\(id)\t\(deviceName(id))")
  } else {
    fputs("error: no default input\n", stderr)
    exit(1)
  }
case "set":
  guard args.count > 2, let id = AudioDeviceID(args[2]) else {
    fputs("usage: mac_audio_input.swift set <deviceId>\n", stderr)
    exit(2)
  }
  guard setDefaultInput(id) else {
    fputs("error: failed to set default input \(id)\n", stderr)
    exit(1)
  }
  print("ok\t\(id)\t\(deviceName(id))")
default:
  fputs("usage: mac_audio_input.swift list|get|set <id>\n", stderr)
  exit(2)
}
