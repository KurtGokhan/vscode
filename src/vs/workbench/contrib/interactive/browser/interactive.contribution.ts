/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { VSBuffer } from 'vs/base/common/buffer';
import { CancellationToken } from 'vs/base/common/cancellation';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { Disposable } from 'vs/base/common/lifecycle';
import { parse } from 'vs/base/common/marshalling';
import { assertType } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { IBulkEditService } from 'vs/editor/browser/services/bulkEditService';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { Action2, registerAction2 } from 'vs/platform/actions/common/actions';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { Registry } from 'vs/platform/registry/common/platform';
import { EditorDescriptor, IEditorRegistry } from 'vs/workbench/browser/editor';
import { Extensions as WorkbenchExtensions, IWorkbenchContribution, IWorkbenchContributionsRegistry } from 'vs/workbench/common/contributions';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { EditorExtensions, EditorsOrder, IEditorInputFactoryRegistry, IEditorInputSerializer, viewColumnToEditorGroup } from 'vs/workbench/common/editor';
import { InteractiveEditor } from 'vs/workbench/contrib/interactive/browser/interactiveEditor';
import { InteractiveEditorInput } from 'vs/workbench/contrib/interactive/browser/interactiveEditorInput';
import { NOTEBOOK_EDITOR_WIDGET_ACTION_WEIGHT } from 'vs/workbench/contrib/notebook/browser/contrib/coreActions';
import { NotebookEditorWidget } from 'vs/workbench/contrib/notebook/browser/notebookEditorWidget';
import { CellEditType, CellKind, ICellOutput } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { INotebookContentProvider, INotebookService } from 'vs/workbench/contrib/notebook/common/notebookService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { ResourceNotebookCellEdit } from 'vs/workbench/contrib/bulkEdit/browser/bulkCellEdits';
import { Schemas } from 'vs/base/common/network';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IInteractiveHistoryService, InteractiveHistoryService } from 'vs/workbench/contrib/interactive/browser/interactiveHistoryService';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { INTERACTIVE_INPUT_CURSOR_BOUNDARY } from 'vs/workbench/contrib/interactive/browser/interactiveCommon';


Registry.as<IEditorRegistry>(EditorExtensions.Editors).registerEditor(
	EditorDescriptor.create(
		InteractiveEditor,
		InteractiveEditor.ID,
		'Interactive Window'
	),
	[
		new SyncDescriptor(InteractiveEditorInput)
	]
);

export class InteractiveDocumentContribution extends Disposable implements IWorkbenchContribution {
	constructor(@INotebookService notebookService: INotebookService) {
		super();

		const contentOptions = {
			transientOutputs: true,
			transientCellMetadata: {},
			transientDocumentMetadata: {}
		};

		const controller: INotebookContentProvider = {
			get options() {
				return contentOptions;
			},
			set options(newOptions) {
				contentOptions.transientCellMetadata = newOptions.transientCellMetadata;
				contentOptions.transientDocumentMetadata = newOptions.transientDocumentMetadata;
				contentOptions.transientOutputs = newOptions.transientOutputs;
			},
			open: async (_uri: URI, _backupId: string | VSBuffer | undefined, _untitledDocumentData: VSBuffer | undefined, _token: CancellationToken) => {
				if (_backupId instanceof VSBuffer) {
					const backup = _backupId.toString();
					try {
						const document = JSON.parse(backup) as { cells: { kind: CellKind, language: string, metadata: any, mime: string | undefined, content: string, outputs?: ICellOutput[] }[] };
						return {
							data: {
								metadata: {},
								cells: document.cells.map(cell => ({
									source: cell.content,
									language: cell.language,
									cellKind: cell.kind,
									mime: cell.mime,
									outputs: cell.outputs
										? cell.outputs.map(output => ({
											outputId: output.outputId,
											outputs: output.outputs.map(ot => ({
												mime: ot.mime,
												data: Uint8Array.from(ot.data)
											}))
										}))
										: [],
									metadata: cell.metadata
								}))
							},
							transientOptions: contentOptions
						};
					} catch (_e) { }
				}

				return {
					data: {
						metadata: {},
						cells: []
					},
					transientOptions: contentOptions
				};
			},
			save: async (uri: URI) => {
				// trigger backup always
				return false;
			},
			saveAs: async (uri: URI, target: URI, token: CancellationToken) => {
				// return this._proxy.$saveNotebookAs(viewType, uri, target, token);
				return false;
			},
			backup: async (uri: URI, token: CancellationToken) => {
				const doc = notebookService.listNotebookDocuments().find(document => document.uri.toString() === uri.toString());
				if (doc) {
					const cells = doc.cells.map(cell => ({
						kind: cell.cellKind,
						language: cell.language,
						metadata: cell.metadata,
						mine: cell.mime,
						outputs: cell.outputs.map(output => {
							return {
								outputId: output.outputId,
								outputs: output.outputs.map(ot => ({
									mime: ot.mime,
									data: Array.from(ot.data)
								}))
							};
						}),
						content: cell.getValue()
					}));

					const buffer = VSBuffer.fromString(JSON.stringify({
						cells: cells
					}));

					return buffer;
				} else {
					return '';
				}
			}
		};
		this._register(notebookService.registerNotebookController('interactive', {
			id: new ExtensionIdentifier('interactive.builtin'),
			location: URI.parse('interactive://test')
		}, controller));

		const info = notebookService.getContributedNotebookType('interactive');

		if (info) {
			info.update({ selectors: ['*.interactive'] });
		} else {
			this._register(notebookService.registerContributedNotebookType('interactive', {
				providerDisplayName: 'Interactive Notebook',
				displayName: 'Interactive',
				filenamePattern: ['*.interactive'],
				exclusive: true
			}));
		}
	}
}

const workbenchContributionsRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench);
workbenchContributionsRegistry.registerWorkbenchContribution(InteractiveDocumentContribution, LifecyclePhase.Starting);

class InteractiveEditorSerializer implements IEditorInputSerializer {
	canSerialize(): boolean {
		return true;
	}

	serialize(input: EditorInput): string {
		assertType(input instanceof InteractiveEditorInput);
		return JSON.stringify({
			resource: input.primary.resource,
			inputResource: input.inputResource,
		});
	}

	deserialize(instantiationService: IInstantiationService, raw: string) {
		type Data = { resource: URI, inputResource: URI; };
		const data = <Data>parse(raw);
		if (!data) {
			return undefined;
		}
		const { resource, inputResource } = data;
		if (!data || !URI.isUri(resource) || !URI.isUri(inputResource)) {
			return undefined;
		}

		const input = InteractiveEditorInput.create(instantiationService, resource, inputResource);
		return input;
	}
}

Registry.as<IEditorInputFactoryRegistry>(EditorExtensions.EditorInputFactories).registerEditorInputSerializer(
	InteractiveEditorInput.ID,
	InteractiveEditorSerializer
);

registerSingleton(IInteractiveHistoryService, InteractiveHistoryService);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'interactive.open',
			title: { value: localize('interactive.open', "Open Interactive Window"), original: 'Open Interactive Window' },
			f1: false,
			category: 'Interactive',
			description: {
				description: localize('notebookActions.executeNotebook', "Run All"),
				args: [
					{
						name: 'column',
						description: 'View Column',
						schema: {
							type: 'number',
							default: -1
						}
					},
					{
						name: 'resource',
						description: 'Interactive resource Uri',
						isOptional: true
					}
				]
			}

		});
	}

	async run(accessor: ServicesAccessor, column?: number, resource?: URI): Promise<{ notebookUri: URI, inputUri: URI; }> {
		const editorService = accessor.get(IEditorService);
		const editorGroupService = accessor.get(IEditorGroupsService);
		const historyService = accessor.get(IInteractiveHistoryService);
		const group = viewColumnToEditorGroup(editorGroupService, column);

		if (resource && resource.scheme === Schemas.vscodeInteractive) {
			const resourceUri = URI.revive(resource);
			const editors = editorService.findEditors(resourceUri).filter(id => id.editor instanceof InteractiveEditorInput && id.editor.resource?.toString() === resourceUri.toString());
			if (editors.length) {
				const editorInput = editors[0].editor as InteractiveEditorInput;
				const currentGroup = editors[0].groupId;
				await editorService.openEditor(editorInput, undefined, currentGroup);
				return {
					notebookUri: editorInput.resource!,
					inputUri: editorInput.inputResource
				};
			}
		}

		const existingNotebookDocument = new Set<string>();
		editorService.getEditors(EditorsOrder.SEQUENTIAL).forEach(editor => {
			if (editor.editor.resource) {
				existingNotebookDocument.add(editor.editor.resource.toString());
			}
		});

		let notebookUri: URI | undefined = undefined;
		let inputUri: URI | undefined = undefined;
		let counter = 1;
		do {
			notebookUri = URI.from({ scheme: Schemas.vscodeInteractive, path: `Interactive-${counter}.interactive` });
			inputUri = URI.from({ scheme: Schemas.vscodeInteractiveInput, path: `InteractiveInput-${counter}` });

			counter++;
		} while (existingNotebookDocument.has(notebookUri.toString()));

		const editorInput = InteractiveEditorInput.create(accessor.get(IInstantiationService), notebookUri, inputUri);
		historyService.clearHistory(notebookUri);
		await editorService.openEditor(editorInput, undefined, group);

		// Extensions must retain references to these URIs to manipulate the interactive editor
		return { notebookUri, inputUri };
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'interactive.execute',
			title: { value: localize('interactive.execute', "Execute Code"), original: 'Execute Code' },
			category: 'Interactive',
			keybinding: {
				// when: NOTEBOOK_CELL_LIST_FOCUSED,
				when: ContextKeyExpr.equals('resourceScheme', Schemas.vscodeInteractive),
				primary: KeyMod.WinCtrl | KeyCode.Enter,
				win: {
					primary: KeyMod.CtrlCmd | KeyCode.Enter
				},
				weight: NOTEBOOK_EDITOR_WIDGET_ACTION_WEIGHT
			},
			f1: false
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const bulkEditService = accessor.get(IBulkEditService);
		const historyService = accessor.get(IInteractiveHistoryService);
		const editorControl = editorService.activeEditorPane?.getControl() as { notebookEditor: NotebookEditorWidget | undefined, codeEditor: CodeEditorWidget; } | undefined;

		if (editorControl && editorControl.notebookEditor && editorControl.codeEditor) {
			const notebookDocument = editorControl.notebookEditor.textModel;
			const textModel = editorControl.codeEditor.getModel();
			const activeKernel = editorControl.notebookEditor.activeKernel;
			const language = activeKernel?.supportedLanguages[0] ?? 'plaintext';

			if (notebookDocument && textModel) {
				const index = notebookDocument.length;
				const value = textModel.getValue();
				historyService.addToHistory(notebookDocument.uri, '');
				textModel.setValue('');

				await bulkEditService.apply([
					new ResourceNotebookCellEdit(notebookDocument.uri,
						{
							editType: CellEditType.Replace,
							index: index,
							count: 0,
							cells: [{
								cellKind: CellKind.Code,
								mime: undefined,
								language,
								source: value,
								outputs: [],
								metadata: {}
							}]
						}
					)
				]);

				await editorControl.notebookEditor.executeNotebookCells(editorControl.notebookEditor.viewModel!.getCells({ start: index, end: index + 1 }));
				editorControl.notebookEditor.revealCellRangeInView({ start: index, end: index + 1 });
			}
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'interactive.history.previous',
			title: { value: localize('interactive.history.previous', "Previous value in history"), original: 'Previous value in history' },
			category: 'Interactive',
			f1: false,
			keybinding: {
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('resourceScheme', Schemas.vscodeInteractive),
					INTERACTIVE_INPUT_CURSOR_BOUNDARY.notEqualsTo('bottom'),
					INTERACTIVE_INPUT_CURSOR_BOUNDARY.notEqualsTo('none'),
				),
				primary: KeyCode.UpArrow,
				weight: KeybindingWeight.WorkbenchContrib
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const historyService = accessor.get(IInteractiveHistoryService);
		const editorControl = editorService.activeEditorPane?.getControl() as { notebookEditor: NotebookEditorWidget | undefined, codeEditor: CodeEditorWidget; } | undefined;

		if (editorControl && editorControl.notebookEditor && editorControl.codeEditor) {
			const notebookDocument = editorControl.notebookEditor.textModel;
			const textModel = editorControl.codeEditor.getModel();

			if (notebookDocument && textModel) {
				const previousValue = historyService.getPreviousValue(notebookDocument.uri);
				if (previousValue) {
					textModel.setValue(previousValue);
				}
			}
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'interactive.history.next',
			title: { value: localize('interactive.history.next', "Next value in history"), original: 'Next value in history' },
			category: 'Interactive',
			f1: false,
			keybinding: {
				when: ContextKeyExpr.and(
					ContextKeyExpr.equals('resourceScheme', Schemas.vscodeInteractive),
					INTERACTIVE_INPUT_CURSOR_BOUNDARY.notEqualsTo('top'),
					INTERACTIVE_INPUT_CURSOR_BOUNDARY.notEqualsTo('none'),
				),
				primary: KeyCode.DownArrow,
				weight: KeybindingWeight.WorkbenchContrib
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const historyService = accessor.get(IInteractiveHistoryService);
		const editorControl = editorService.activeEditorPane?.getControl() as { notebookEditor: NotebookEditorWidget | undefined, codeEditor: CodeEditorWidget; } | undefined;

		if (editorControl && editorControl.notebookEditor && editorControl.codeEditor) {
			const notebookDocument = editorControl.notebookEditor.textModel;
			const textModel = editorControl.codeEditor.getModel();

			if (notebookDocument && textModel) {
				const previousValue = historyService.getNextValue(notebookDocument.uri);
				if (previousValue) {
					textModel.setValue(previousValue);
				}
			}
		}
	}
});

