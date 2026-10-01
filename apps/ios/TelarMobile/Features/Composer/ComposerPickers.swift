import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum ComposerPicker: Identifiable {
    case photos, camera, files
    var id: Self { self }

    static var hasCamera: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
}

struct ComposerPickers: ViewModifier {
    @Binding var picking: ComposerPicker?
    let onPick: ([ComposerIntakeResult]) -> Void

    @State private var photos: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: showing(.photos), selection: $photos, maxSelectionCount: 8, matching: .images)
            .onChange(of: photos) { _, items in
                guard !items.isEmpty else { return }
                photos = []
                Task {
                    var results: [ComposerIntakeResult] = []
                    for item in items {
                        let type = item.supportedContentTypes.first
                        if let data = try? await item.loadTransferable(type: Data.self) {
                            results.append(ComposerIntake.take(data, name: nil, type: type, fallback: "photo"))
                        } else {
                            results.append(.refused("A photo could not be read."))
                        }
                    }
                    onPick(results)
                }
            }
            .fileImporter(isPresented: showing(.files), allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                switch result {
                case .success(let urls): onPick(urls.map { ComposerIntake.take(fileAt: $0) })
                case .failure(let error): onPick([.refused(error.localizedDescription)])
                }
            }
            .fullScreenCover(isPresented: showing(.camera)) {
                CameraPicker { image in
                    picking = nil
                    guard let image else { return }
                    guard let data = image.jpegData(compressionQuality: 0.85) else {
                        onPick([.refused("The photo could not be saved.")])
                        return
                    }
                    onPick([ComposerIntake.take(data, name: nil, type: .jpeg, fallback: "photo")])
                }
                .ignoresSafeArea()
            }
    }

    private func showing(_ picker: ComposerPicker) -> Binding<Bool> {
        Binding(get: { picking == picker }, set: { if !$0, picking == picker { picking = nil } })
    }
}

private struct CameraPicker: UIViewControllerRepresentable {
    let onFinish: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?) -> Void
        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onFinish(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onFinish(nil) }
    }
}
