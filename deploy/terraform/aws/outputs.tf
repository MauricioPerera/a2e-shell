output "alb_dns_name" {
  description = "ALB hostname. Point your DNS record at this."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone id, for Route53 alias records."
  value       = aws_lb.this.zone_id
}

output "auth_token_secret_arn" {
  description = "Secrets Manager ARN for the bearer token."
  value       = aws_secretsmanager_secret.auth_token.arn
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "log_group_name" {
  description = "CloudWatch log group receiving stdout."
  value       = aws_cloudwatch_log_group.this.name
}

output "efs_file_system_id" {
  description = "EFS id backing /sessions on the tasks."
  value       = aws_efs_file_system.sessions.id
}
