import type { ReviewDocument } from './types';

/** Reporte de ejemplo para el botón "Ver ejemplo" — sirve para demos y QA sin correr un agente. */
export const SAMPLE_DOCUMENT: ReviewDocument = {
	intent:
		'Habilita el flujo DEBIN de vendedor mediante POST de pre-órdenes y diferencia comprador (PAGO_DEBIN) de vendedor (GENERAR_DEBIN) usando rol en consultas. Reorganiza DTOs Shared/Internal, agrega retry con Polly para el cliente HTTP de Bantotal y expone el endpoint de pre-órdenes con MediatR.',
	groups: [
		{
			id: 'g1',
			kind: 'feat',
			title: 'feat(vendedor): flujo PostPreOrden end-to-end',
			intent: 'Nuevo endpoint que recibe la pre-orden del vendedor y la despacha vía MediatR hacia aprobaciones.'
		},
		{
			id: 'g2',
			kind: 'feat',
			title: 'feat(rol): distingue operaciones comprador/vendedor',
			intent: 'GetTransactionType ahora resuelve el tipo según el rol para no mezclar PAGO_DEBIN con GENERAR_DEBIN.'
		},
		{
			id: 'g3',
			kind: 'infra',
			title: 'feat(infra): retry con Polly para HttpClient de Bantotal',
			intent: 'Agrega política de reintentos con backoff para llamadas transitorias, evitando reintentar POST no idempotentes.'
		},
		{
			id: 'g4',
			kind: 'chore',
			title: 'chore(release): configuración por rol y limpieza de constantes',
			intent: 'Ajusta config y remueve una constante de moneda duplicada.'
		}
	],
	blocks: [
		{
			id: 'b1',
			group: 'g1',
			file: 'Core/Controllers/V1/PreOrdenesController.cs',
			lines: 'L1-33',
			side: 'new',
			start: 1,
			end: 33,
			op: 'add',
			what: 'Nuevo controller POST que envía PostPreOrdenRequest via MediatR y retorna 200.',
			why: 'Expone el endpoint api/v1.0/pre-ordenes para el flujo vendedor hacia aprobaciones.',
			source: 'code'
		},
		{
			id: 'b2',
			group: 'g2',
			file: 'Core/Application/Validators/GetOrdenRequestValidator.cs',
			lines: 'L17-18',
			side: 'new',
			start: 17,
			end: 18,
			op: 'mod',
			what: 'RuleFor Rol con MustBeValidRole y RolesConstants.RolesValidos.',
			why: 'Evitar consultas con rol inválido que rompen GetTransactionType.',
			source: 'code'
		},
		{
			id: 'b3',
			group: 'g3',
			file: 'Core/Infra/PollyPolicyBuilder.cs',
			lines: 'L18-25',
			side: 'new',
			start: 18,
			end: 25,
			op: 'mod',
			what: 'GetPolicy corta a NoOp si el request es POST.',
			why: 'Evita reintentar operaciones no idempotentes contra Bantotal.',
			source: 'code'
		},
		{
			id: 'b4',
			group: 'g4',
			file: 'Core/Constants/MonedasConstants.cs',
			lines: 'L20-27',
			side: 'old',
			start: 20,
			end: 27,
			op: 'del',
			what: 'Borra _divisaBantotal, mapeo duplicado de _bantotalDivisa.',
			why: 'Las dos constantes mapeaban el mismo código de moneda.',
			source: 'code'
		}
	],
	findings: [
		{
			id: 'f1',
			class: 'risk',
			severity: 'high',
			blocking: true,
			kind: 'bug',
			file: 'Core/Application/Validators/GetOrdenRequestValidator.cs',
			line: 17,
			block: 'b2',
			what: 'MustBeValidRole no cubre "ADMIN", usado en 3 callers del área de soporte.',
			fix: 'Agregar "ADMIN" a RolesConstants.RolesValidos o documentar que ya no se soporta.'
		},
		{
			id: 'f2',
			class: 'risk',
			severity: 'high',
			blocking: true,
			kind: 'race',
			file: 'Core/Controllers/V1/PreOrdenesController.cs',
			line: 28,
			block: 'b1',
			what: 'Dos POST concurrentes de la misma orden no se deduplican: pueden crear dos registros.',
			fix: 'Índice único por IdDebin+tipo o lock/upsert antes de persistir.'
		},
		{
			id: 'f3',
			class: 'quality',
			severity: 'med',
			blocking: false,
			kind: 'perf',
			file: 'Core/Infra/PollyPolicyBuilder.cs',
			line: 20,
			block: 'b3',
			what: 'El chequeo de POST se hace antes de resolver la policy real; también aplica NoOp a PUT/PATCH que sí son idempotentes.',
			fix: 'Ampliar la condición a POST estrictamente, no a todo lo no-GET.'
		},
		{
			id: 'f4',
			class: 'quality',
			severity: 'low',
			blocking: false,
			kind: 'maintainability',
			file: 'Core/Constants/MonedasConstants.cs',
			line: 20,
			block: 'b4',
			what: 'Se borra _divisaBantotal pero queda un comentario que todavía lo referencia.',
			fix: 'Actualizar el comentario de la clase.'
		},
		{
			id: 'f5',
			class: 'risk',
			severity: 'med',
			blocking: false,
			kind: 'missing-test',
			file: 'Core/Controllers/V1/PreOrdenesController.cs',
			line: null,
			block: '',
			what: 'No hay test que cubra el POST con IdDebin repetido.',
			fix: 'Agregar test de integración para el caso de duplicado.'
		},
		{
			id: 'f6',
			class: 'quality',
			severity: 'nit',
			blocking: false,
			kind: 'docs',
			file: 'Core/Application/Validators/GetOrdenRequestValidator.cs',
			line: null,
			block: '',
			what: 'El validador no documenta qué roles son válidos en el summary.',
			fix: 'Sumar un comentario con la lista de roles esperados.'
		}
	],
	skipped: [
		{ file: 'Core/MsObeAprobacionDebin.Application.csproj', reason: 'generated' },
		{ file: 'package-lock.json', reason: 'lockfile' }
	],
	files: [
		{
			path: 'Core/Controllers/V1/PreOrdenesController.cs',
			changeType: 'added',
			group: 'g1',
			diff: '@@ -0,0 +1,33 @@\n+using MediatR;\n+using Microsoft.AspNetCore.Http;\n+using Microsoft.AspNetCore.Mvc;\n+using MsObeAprobacionDebin.Application.Dtos.PostPreOrden.Input;\n+using MsObeAprobacionDebin.Application.Dtos.PostPreOrden.Output;\n+using MsObeAprobacionDebin.Application.Features.Vendedor.Commands;\n+using MsObeAprobacionDebin.Controllers.Base;\n+\n+namespace MsObeAprobacionDebin.Controllers.V1;\n+\n+[ApiController]\n+public class PreOrdenesController : BaseController\n+{\n+    public PreOrdenesController(IMediator mediator) : base(mediator) { }\n+\n+    [HttpPost]\n+    [ProducesResponseType(typeof(PostPreOrdenResponse), StatusCodes.Status200OK)]\n+    public async Task<IActionResult> PostPreOrdenAsync([FromBody] PostPreOrdenRequest postPreOrdenRequest)\n+    {\n+        var result = await Mediator.Send(new PostPreOrden(postPreOrdenRequest));\n+        return Ok(result);\n+    }\n+}'
		},
		{
			path: 'Core/Application/Validators/GetOrdenRequestValidator.cs',
			changeType: 'modified',
			group: 'g2',
			diff: '@@ -1,4 +1,6 @@\n using FluentValidation;\n+using MsObeAprobacionDebin.Application.Common;\n+using MsObeAprobacionDebin.Application.Constants;\n using MsObeAprobacionDebin.Application.Dtos.GetOrden.Input;\n \n namespace MsObeAprobacionDebin.Application.Validators;\n@@ -11,5 +13,8 @@ public class GetOrdenRequestValidator : AbstractValidator<GetOrdenRequest>\n         RuleFor(o => o.IdDebin)\n             .NotEmpty().WithMessage("El id de la orden de debin no puede estar nulo o vacío.");\n \n+        RuleFor(o => o.Rol)\n+            .MustBeValidRole($"El rol recibido no es válido. (Roles válidos: {string.Join(", ", RolesConstants.RolesValidos)})");\n+\n     }\n }'
		},
		{
			path: 'Core/Infra/PollyPolicyBuilder.cs',
			changeType: 'modified',
			group: 'g3',
			diff: '@@ -16,7 +16,9 @@ namespace Bff.Obe.Pago.Servicios.Infrastructure\n     public static class PollyPolicyBuilder\n     {\n+        public static IAsyncPolicy<HttpResponseMessage> GetPolicy(HttpRequestMessage request)\n+        {\n+            if (request.Method == HttpMethod.Post)\n+                return Policy.NoOpAsync<HttpResponseMessage>();\n+\n+            return BuildRetryPolicy();\n+        }\n \n         public static IAsyncPolicy<HttpResponseMessage> BuildRetryPolicy()\n         {'
		},
		{
			path: 'Core/Constants/MonedasConstants.cs',
			changeType: 'modified',
			group: 'g4',
			diff: '@@ -18,12 +18,4 @@ public static class MonedasConstants\n     public const string Ars = "ARS";\n     public const string Usd = "USD";\n \n-    // Duplicado histórico de _bantotalDivisa, mismo mapeo de código.\n-    public static readonly Dictionary<int, string> _divisaBantotal = new()\n-    {\n-        { 32, Ars },\n-        { 840, Usd }\n-    };\n-\n     public static readonly Dictionary<int, string> _bantotalDivisa = new()'
		}
	],
	notes: ['El diff completo tenía 162 archivos; este ejemplo incluye solo 4 para mostrar el viewer.']
};
